import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCodexLifecycleJob } from "../../src/server/codexLifecycleRunner.js";
import type { ProviderRegistry } from "../../src/registry.js";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
} from "../../src/providers/IProvider.js";
import type { CodexLifecycleDecision } from "../../src/util/codexLifecycle.js";
import {
  COMPOSER_STATE_DIR_ENV,
  newCodexLifecycleJob,
} from "../../src/util/codexLifecycleJob.js";

const decision: CodexLifecycleDecision = {
  event: "postPlan",
  action: "run",
  score: 90,
  threshold: 60,
  model: "gpt-5.4-mini",
  execution: "foreground",
  reasons: ["test"],
};

describe("runCodexLifecycleJob cancellation bounds", () => {
  const roots: string[] = [];
  let previousStateDir: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    if (previousStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousStateDir;
    previousStateDir = undefined;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "composer-life-run-"));
    const state = mkdtempSync(join(tmpdir(), "composer-life-run-state-"));
    roots.push(root, state);
    previousStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = state;
    return root;
  }

  function registry(providers: Record<string, IProvider>): ProviderRegistry {
    return {
      getProviderForRole(role: string): IProvider {
        const provider = providers[role];
        if (!provider) throw new Error(`missing provider ${role}`);
        return provider;
      },
    } as unknown as ProviderRegistry;
  }

  it("stops fallback roles when the shared signal aborts mid-chain", async () => {
    const root = tempRoot();
    const calls: string[] = [];
    const ac = new AbortController();
    let reviewerClaudeStarted!: () => void;
    const reviewerClaudeReady = new Promise<void>((resolve) => {
      reviewerClaudeStarted = resolve;
    });

    const coderCli = provider("coderCli", async () => {
      calls.push("coderCli");
      throw new Error("not authenticated");
    });
    const reviewerClaude = provider("reviewerClaude", async (input) => {
      calls.push("reviewerClaude");
      reviewerClaudeStarted();
      const signal = input.signal;
      if (!signal) throw new Error("missing lifecycle signal");
      return new Promise<IProviderExecuteOutput>((_resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const reviewer = provider("reviewer", async () => {
      calls.push("reviewer");
      return { text: "should not run" };
    });

    const pending = runCodexLifecycleJob({
      root,
      registry: registry({ coderCli, reviewerClaude, reviewer }),
      job: newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "foreground",
      }),
      prompt: "review",
      signal: ac.signal,
      fallback: { enabled: true, order: ["reviewerClaude", "reviewer"] },
      maxTotalMs: 10_000,
    });

    await reviewerClaudeReady;
    ac.abort(new Error("external abort"));

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.unavailableReason).toBe("cancelled");
    expect(calls).toEqual(["coderCli", "reviewerClaude"]);
  });

  it("enforces one total lifecycle deadline across fallback roles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const root = tempRoot();
    const calls: string[] = [];
    const coderCli = provider("coderCli", async () => {
      calls.push("coderCli");
      vi.setSystemTime(60);
      throw new Error("not authenticated");
    });
    const reviewerClaude = provider("reviewerClaude", async () => {
      calls.push("reviewerClaude");
      return { text: "should not run" };
    });

    const result = await runCodexLifecycleJob({
      root,
      registry: registry({ coderCli, reviewerClaude }),
      job: newCodexLifecycleJob(root, {
        event: "postPlan",
        decision,
        execution: "foreground",
      }),
      prompt: "review",
      fallback: { enabled: true, order: ["reviewerClaude"] },
      maxTotalMs: 50,
    });

    expect(result.status).toBe("failed");
    expect(result.unavailableReason).toBe("timeout");
    expect(result.error).toContain("timed out after 50ms");
    expect(calls).toEqual(["coderCli"]);
  });
});

function provider(
  modelLabel: string,
  execute: (input: IProviderExecuteInput) => Promise<IProviderExecuteOutput>,
): IProvider {
  return {
    id: "mock",
    modelLabel,
    async healthCheck() {
      return true;
    },
    execute,
  };
}
