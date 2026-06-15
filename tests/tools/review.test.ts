import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createComposerServer } from "../../src/server.js";
import type { ProviderRegistry } from "../../src/registry.js";
import { parseConfig } from "../../src/config/loader.js";
import type { ComposerConfig } from "../../src/config/schema.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { IProvider, IProviderExecuteInput, IProviderExecuteOutput } from "../../src/providers/IProvider.js";

const config: ComposerConfig = parseConfig({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
    reviewerClaude: { provider: "mock", model: "reviewer-claude-mock" },
  },
});

async function bootClient(root: string, providers: Record<string, IProvider>) {
  const fallback = new MockProvider();
  const registry = {
    getProviderForRole(role: string): IProvider {
      return providers[role] ?? fallback;
    },
  } as unknown as ProviderRegistry;
  const server = createComposerServer(registry, { root, config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "composer-review-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client };
}

function delayedProvider(ms: number, text: string): IProvider & { calls: IProviderExecuteInput[] } {
  const calls: IProviderExecuteInput[] = [];
  return {
    id: "mock",
    modelLabel: "delayed-reviewer",
    calls,
    async healthCheck() {
      return true;
    },
    async execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput> {
      calls.push(input);
      await delay(ms);
      return { text, tokensIn: input.prompt.length, tokensOut: text.length };
    },
  };
}

describe("review tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "composer-review-tool-"));
    roots.push(root);
    return root;
  }

  function textBlock(result: unknown): string {
    const content = (result as { content?: unknown }).content;
    return ((content as Array<{ type: string; text: string }> | undefined)?.[0]?.text) ?? "";
  }

  it("composer_review_job_start returns immediately and result polling returns the mock review", async () => {
    const root = tempRoot();
    const reviewer = delayedProvider(
      40,
      "VERDICT: PASS\nSUMMARY: No blocking findings.\nFull review text.",
    );
    const { client } = await bootClient(root, { reviewer });

    const started = await client.callTool({
      name: "composer_review_job_start",
      arguments: {
        prompt: "scan for bugs",
        diff: "--- a/x\n+++ b/x\n+console.log()",
      },
    });
    expect(started.isError).not.toBe(true);
    const startJob = JSON.parse(textBlock(started)) as {
      jobId: string;
      pollAfterMs: number;
      status: string;
    };
    expect(startJob.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(startJob.pollAfterMs)).toBe(true);
    expect(startJob.pollAfterMs).toBeGreaterThan(0);
    expect(["queued", "running"]).toContain(startJob.status);

    const polled = await client.callTool({
      name: "composer_review_job_result",
      arguments: { jobId: startJob.jobId, waitMs: 5_000 },
    });
    const job = JSON.parse(textBlock(polled)) as {
      status: string;
      result?: { verdict?: string; summary?: string; text?: string };
    };

    expect(job.status).toBe("succeeded");
    expect(job.result?.verdict).toBe("PASS");
    expect(job.result?.summary).toBe("No blocking findings.");
    expect(job.result?.text).toContain("Full review text.");
    expect(job).not.toHaveProperty("pollAfterMs");
    expect(reviewer.calls[0]?.context).toContain("console.log()");
    expect(reviewer.calls[0]?.cwd).toBe(resolve(root));
  });

  it("composer_review_job_result waitMs waits for completion of the latest job", async () => {
    const root = tempRoot();
    const reviewer = delayedProvider(40, "VERDICT: WARN\nSUMMARY: Check edge cases.");
    const { client } = await bootClient(root, { reviewer });

    await client.callTool({
      name: "composer_review_job_start",
      arguments: {
        prompt: "scan latest",
        diff: "--- a/x\n+++ b/x\n+change",
      },
    });
    const result = await client.callTool({
      name: "composer_review_job_result",
      arguments: { waitMs: 5_000 },
    });
    const job = JSON.parse(textBlock(result)) as { status: string; result?: { verdict?: string } };

    expect(job.status).toBe("succeeded");
    expect(job.result?.verdict).toBe("WARN");
  });

  it("composer_review_job_start routes claude:true to reviewerClaude", async () => {
    const root = tempRoot();
    const reviewer = delayedProvider(1, "VERDICT: DEFAULT");
    const reviewerClaude = delayedProvider(1, "VERDICT: CLAUDE\nSUMMARY: Premium review.");
    const { client } = await bootClient(root, { reviewer, reviewerClaude });

    const started = await client.callTool({
      name: "composer_review_job_start",
      arguments: {
        prompt: "premium scan",
        diff: "--- a/x\n+++ b/x\n+change",
        claude: true,
      },
    });
    const startJob = JSON.parse(textBlock(started)) as { jobId: string };
    const result = await client.callTool({
      name: "composer_review_job_result",
      arguments: { jobId: startJob.jobId, waitMs: 5_000 },
    });
    const job = JSON.parse(textBlock(result)) as { result?: { verdict?: string } };

    expect(job.result?.verdict).toBe("CLAUDE");
    expect(reviewer.calls).toHaveLength(0);
    expect(reviewerClaude.calls).toHaveLength(1);
  });

  it("unknown review jobId returns a clear not-found shape", async () => {
    const root = tempRoot();
    const { client } = await bootClient(root, {});
    const missingId = "00000000-0000-4000-8000-000000000000";

    const result = await client.callTool({
      name: "composer_review_job_result",
      arguments: { jobId: missingId },
    });
    const body = JSON.parse(textBlock(result)) as {
      found: boolean;
      jobId: string;
      message: string;
    };

    expect(body).toEqual({
      found: false,
      jobId: missingId,
      message: `No review job found for ${missingId}.`,
    });
  });

  it("composer_review_job_result is read-only for completed jobs", async () => {
    const root = tempRoot();
    const reviewer = delayedProvider(1, "VERDICT: PASS\nSUMMARY: Stable.");
    const { client } = await bootClient(root, { reviewer });
    const started = await client.callTool({
      name: "composer_review_job_start",
      arguments: {
        prompt: "scan",
        diff: "--- a/x\n+++ b/x\n+change",
      },
    });
    const startJob = JSON.parse(textBlock(started)) as { jobId: string };
    await client.callTool({
      name: "composer_review_job_result",
      arguments: { jobId: startJob.jobId, waitMs: 5_000 },
    });
    const jobPath = join(root, ".composer", "review-jobs", `${startJob.jobId}.json`);
    const before = readFileSync(jobPath, "utf8");

    await client.callTool({
      name: "composer_review_job_result",
      arguments: { jobId: startJob.jobId },
    });

    expect(readFileSync(jobPath, "utf8")).toBe(before);
  });
});
