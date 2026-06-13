import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectDir } from "../util/applyFileBlocks.js";
import { contextWithHandoff } from "./handoffContext.js";
import {
  classifyCodexLifecycleUnavailable,
  updateCodexLifecycleJob,
  type CodexLifecycleJob,
} from "../util/codexLifecycleJob.js";
import type { CodexLifecycleFallback, RoleName } from "../config/schema.js";
import type { ProviderRegistry } from "../registry.js";

export interface RunCodexLifecycleJobInput {
  root: string;
  registry: ProviderRegistry;
  job: CodexLifecycleJob;
  prompt: string;
  context?: string;
  handoffPath?: string;
  projectDir?: string;
  signal?: AbortSignal;
  fallback?: CodexLifecycleFallback;
}

export async function runCodexLifecycleJob(
  input: RunCodexLifecycleJobInput,
): Promise<CodexLifecycleJob> {
  const targetRoot = resolveProjectDir(input.projectDir, input.root);
  let job = updateCodexLifecycleJob(input.root, input.job, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  const roles = lifecycleProviderRoles(input.fallback);
  let lastError: unknown;
  let lastReason: ReturnType<typeof classifyCodexLifecycleUnavailable> = "unknown";

  for (const role of roles) {
    const attemptStartedAt = new Date().toISOString();
    const executionTarget = lifecycleExecutionTarget(role, targetRoot);
    try {
      const provider = input.registry.getProviderForRole(role);
      const result = await provider.execute({
        prompt: codexLifecyclePrompt(job, input.prompt, role),
        context: contextWithHandoff(input.root, input.context, input.handoffPath),
        cwd: executionTarget.cwd,
        projectDir: executionTarget.projectDir,
        readOnly: executionTarget.readOnly,
        model: input.job.model,
        signal: input.signal,
      });
      job = updateCodexLifecycleJob(input.root, job, {
        status: "succeeded",
        completedAt: new Date().toISOString(),
        resultText: result.text,
        providerRole: role,
        fallbackUsed: role === "coderCli" ? undefined : role,
        attempts: [
          ...job.attempts,
          {
            role,
            status: "succeeded",
            startedAt: attemptStartedAt,
            completedAt: new Date().toISOString(),
          },
        ],
      });
      return job;
    } catch (error) {
      lastError = error;
      lastReason = classifyCodexLifecycleUnavailable(error);
      job = updateCodexLifecycleJob(input.root, job, {
        attempts: [
          ...job.attempts,
          {
            role,
            status: "unavailable",
            startedAt: attemptStartedAt,
            completedAt: new Date().toISOString(),
            unavailableReason: lastReason,
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    } finally {
      executionTarget.cleanup();
    }
  }

  job = updateCodexLifecycleJob(input.root, job, {
    status: "unavailable",
    completedAt: new Date().toISOString(),
    error: lastError instanceof Error ? lastError.message : String(lastError),
    unavailableReason: lastReason,
    resultText:
      `Lifecycle providers unavailable (${lastReason}) and no fallback provider succeeded. ` +
      "Coco should continue optional lifecycle work without treating this as a policy skip; " +
      "forced gates must fail closed in their own hook.",
  });
  return job;
}

export function lifecycleProviderRoles(fallback: CodexLifecycleFallback | undefined): RoleName[] {
  const roles: RoleName[] = ["coderCli"];
  if (fallback?.enabled) {
    for (const role of fallback.order) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

export function lifecycleExecutionTarget(
  role: RoleName,
  targetRoot: string,
): { cwd: string; projectDir?: string; readOnly?: boolean; cleanup: () => void } {
  if (role === "coderCli") {
    return {
      cwd: targetRoot,
      projectDir: targetRoot,
      readOnly: true,
      cleanup: () => {},
    };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-lifecycle-readonly-"));
  return {
    cwd: tempDir,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function codexLifecyclePrompt(job: CodexLifecycleJob, prompt: string, role: RoleName): string {
  return [
    "You are a Composer lifecycle companion participating in a checkpoint.",
    `Event: ${job.event}`,
    `Job ID: ${job.jobId}`,
    `Execution: ${job.execution}`,
    `Provider role: ${role}`,
    "",
    "Return a concise result for Coco to merge back into the main development loop.",
    "Do not silently mutate files in this lifecycle companion pass.",
    "If code changes are needed, provide findings, file references, and patch guidance instead.",
    "Use this structure: Verdict, Findings, Suggested next actions, Checks.",
    "",
    "Lifecycle task:",
    prompt,
  ].join("\n");
}
