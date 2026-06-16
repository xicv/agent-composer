import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import { computeReviewDiff } from "../util/reviewDiff.js";
import {
  COMPOSER_REVIEW,
  COMPOSER_REVIEW_CLAUDE,
  COMPOSER_REVIEW_JOB_RESULT,
  COMPOSER_REVIEW_JOB_START,
  REVIEW_DESCRIPTION,
  REVIEW_CLAUDE_DESCRIPTION,
  REVIEW_JOB_RESULT_DESCRIPTION,
  REVIEW_JOB_START_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  newReviewJob,
  readLatestReviewJob,
  readReviewJob,
  updateReviewJob,
  writeReviewJob,
} from "../util/reviewJob.js";
import { DEFAULT_ANTHROPIC_TIMEOUT_MS } from "../providers/AnthropicCompatibleProvider.js";
import type { ServerToolContext } from "./context.js";

const REVIEW_SCOPE_SCHEMA = z.enum(["staged", "unstaged", "working-tree", "branch"]);
const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = DEFAULT_ANTHROPIC_TIMEOUT_MS;

export function registerReviewTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_REVIEW,
    {
      description: REVIEW_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1).optional(),
        handoffPath: z.string().optional(),
        reviewScope: REVIEW_SCOPE_SCHEMA.optional(),
        reviewFiles: z.array(z.string().min(1)).optional(),
        base: z.string().min(1).optional(),
      },
      annotations: {
        title: "Composer Review",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath, reviewScope, reviewFiles, base }, extra) => {
      ctx.refreshConfigIfChanged();
      const effectiveDiff = resolveReviewDiff(root, {
        diff,
        reviewScope,
        reviewFiles,
        base,
        toolName: COMPOSER_REVIEW,
      });
      const provider = registry.getProviderForRole("reviewer");
      const toolSignal = createBoundedSignal(
        COMPOSER_REVIEW,
        resolveRoleTimeoutMs(ctx.getActiveConfig()?.roles.reviewer?.timeoutMs),
        extra.signal,
      );
      try {
        const result = await withProgress(extra, COMPOSER_REVIEW, () =>
          provider.execute({
            prompt,
            context: contextWithHandoff(root, effectiveDiff, handoffPath),
            signal: toolSignal.signal,
          }),
          { tracker: ctx.activeRuns },
        );
        return { content: [{ type: "text", text: result.text }] };
      } finally {
        toolSignal.cleanup();
      }
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_CLAUDE,
    {
      description: REVIEW_CLAUDE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1).optional(),
        handoffPath: z.string().optional(),
        reviewScope: REVIEW_SCOPE_SCHEMA.optional(),
        reviewFiles: z.array(z.string().min(1)).optional(),
        base: z.string().min(1).optional(),
      },
      annotations: {
        title: "Composer Review (Claude Premium)",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath, reviewScope, reviewFiles, base }, extra) => {
      ctx.refreshConfigIfChanged();
      const effectiveDiff = resolveReviewDiff(root, {
        diff,
        reviewScope,
        reviewFiles,
        base,
        toolName: COMPOSER_REVIEW_CLAUDE,
      });
      const provider = registry.getProviderForRole("reviewerClaude");
      const toolSignal = createBoundedSignal(
        COMPOSER_REVIEW_CLAUDE,
        resolveRoleTimeoutMs(ctx.getActiveConfig()?.roles.reviewerClaude?.timeoutMs),
        extra.signal,
      );
      try {
        const result = await withProgress(extra, COMPOSER_REVIEW_CLAUDE, () =>
          provider.execute({
            prompt,
            context: contextWithHandoff(root, effectiveDiff, handoffPath),
            cwd: root,
            signal: toolSignal.signal,
          }),
          { tracker: ctx.activeRuns },
        );
        return { content: [{ type: "text", text: result.text }] };
      } finally {
        toolSignal.cleanup();
      }
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_JOB_START,
    {
      description: REVIEW_JOB_START_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1).optional(),
        handoffPath: z.string().optional(),
        reviewScope: REVIEW_SCOPE_SCHEMA.optional(),
        reviewFiles: z.array(z.string().min(1)).optional(),
        base: z.string().min(1).optional(),
        claude: z.boolean().optional().default(false),
      },
      annotations: {
        title: "Composer Review Job Start",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, diff, handoffPath, reviewScope, reviewFiles, base, claude }) => {
      ctx.refreshConfigIfChanged();
      const effectiveDiff = resolveReviewDiff(root, {
        diff,
        reviewScope,
        reviewFiles,
        base,
        toolName: COMPOSER_REVIEW_JOB_START,
      });
      const reviewRole = claude ? "reviewerClaude" : "reviewer";
      const provider = registry.getProviderForRole(reviewRole);
      const jobTimeoutMs = resolveRoleTimeoutMs(
        ctx.getActiveConfig()?.roles[reviewRole]?.timeoutMs,
      );
      let job = writeReviewJob(
        root,
        newReviewJob({
          scope: reviewScope,
          base,
          reviewFiles,
          promptPreview: prompt.slice(0, 200),
          claude,
        }),
      );
      const context = contextWithHandoff(root, effectiveDiff, handoffPath);
      const runner = async () => {
        const jobSignal = createBoundedSignal(
          "composer_review_job_start",
          jobTimeoutMs,
        );
        try {
          const running = updateReviewJob(root, job, {
            status: "running",
            startedAt: new Date().toISOString(),
          });
          try {
            const result = await provider.execute({
              prompt,
              context,
              cwd: root,
              signal: jobSignal.signal,
            });
            updateReviewJob(root, running, {
              status: "succeeded",
              completedAt: new Date().toISOString(),
              result: parseReviewResult(result.text),
            });
          } catch (error) {
            updateReviewJob(root, running, {
              status: "failed",
              completedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          jobSignal.cleanup();
        }
      };
      void runner().catch(() => {
        // The runner persists failures to the durable job record; this only
        // prevents an unobserved promise rejection from escaping the server.
      });
      return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_JOB_RESULT,
    {
      description: REVIEW_JOB_RESULT_DESCRIPTION,
      inputSchema: {
        jobId: z.string().uuid().optional(),
        waitMs: z.number().int().min(0).max(600000).optional(),
      },
      annotations: {
        title: "Composer Review Job Result",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ jobId, waitMs }) => {
      const deadline = Date.now() + (waitMs ?? 0);
      const read = () => (jobId ? readReviewJob(root, jobId) : readLatestReviewJob(root));
      let job = read();
      while (
        job &&
        (job.status === "queued" || job.status === "running") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        job = read();
      }
      const response = job ?? {
        found: false,
        jobId: jobId ?? null,
        message: jobId ? `No review job found for ${jobId}.` : "No review jobs found.",
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    },
  );
}

function resolveReviewDiff(
  root: string,
  input: {
    diff?: string;
    reviewScope?: "staged" | "unstaged" | "working-tree" | "branch";
    reviewFiles?: string[];
    base?: string;
    toolName: string;
  },
): string {
  const effectiveDiff =
    input.reviewScope !== undefined
      ? computeReviewDiff(root, input.reviewScope, { base: input.base, files: input.reviewFiles })
      : input.diff;
  if (!effectiveDiff) {
    throw new Error(`${input.toolName}: provide either \`diff\` or \`reviewScope\`.`);
  }
  return effectiveDiff;
}

function parseReviewResult(text: string): { verdict?: string; summary?: string; text: string } {
  const verdict = firstMarkerValue(text, "VERDICT");
  const summary = firstMarkerValue(text, "SUMMARY");
  return {
    ...(verdict ? { verdict } : {}),
    ...(summary ? { summary } : {}),
    text,
  };
}

function firstMarkerValue(text: string, marker: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${marker}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim();
}

function resolveRoleTimeoutMs(configuredTimeoutMs: unknown): number {
  return typeof configuredTimeoutMs === "number" &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_BACKGROUND_JOB_TIMEOUT_MS;
}

function createBoundedSignal(label: string, timeoutMs: number, callerSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const combinedController = new AbortController();
  const controller = new AbortController();
  const timeoutError = new Error(`${label}: timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  const abortFrom = (source: AbortSignal) => {
    if (combinedController.signal.aborted) return;
    combinedController.abort(abortReason(source, label));
  };
  const onTimeoutAbort = () => abortFrom(controller.signal);
  const onCallerAbort = () => {
    if (callerSignal) abortFrom(callerSignal);
  };

  if (callerSignal?.aborted) {
    abortFrom(callerSignal);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  controller.signal.addEventListener("abort", onTimeoutAbort, { once: true });

  return {
    signal: combinedController.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onTimeoutAbort);
    },
  };
}

function abortReason(signal: AbortSignal, label: string): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : `${label}: aborted`,
  );
  error.name = "AbortError";
  return error;
}
