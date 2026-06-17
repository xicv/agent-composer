import { z } from "zod";
import { withProgress } from "../server/progress.js";
import { resolveProjectDir } from "../util/applyFileBlocks.js";
import {
  COMPOSER_CODEX_LIFECYCLE_DECIDE,
  COMPOSER_CODEX_LIFECYCLE_RUN,
  COMPOSER_CODEX_LIFECYCLE_RESULT,
  CODEX_LIFECYCLE_DECIDE_DESCRIPTION,
  CODEX_LIFECYCLE_RUN_DESCRIPTION,
  CODEX_LIFECYCLE_RESULT_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  decideCodexLifecycle,
  resolveCodexLifecycle,
} from "../util/codexLifecycle.js";
import {
  newCodexLifecycleJob,
  readCodexLifecycleJob,
  readLatestCodexLifecycleJob,
  updateCodexLifecycleJob,
  writeCodexLifecycleJob,
} from "../util/codexLifecycleJob.js";
import { runCodexLifecycleJob } from "../server/codexLifecycleRunner.js";
import type { ServerToolContext } from "./context.js";

export function registerCodexLifecycleTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_CODEX_LIFECYCLE_DECIDE,
    {
      description: CODEX_LIFECYCLE_DECIDE_DESCRIPTION,
      inputSchema: {
        event: z.enum([
          "postResearch",
          "postPlan",
          "postCodeApply",
          "postTestFailure",
          "afterFailedAttempts",
          "preCommit",
          "stopWarm",
        ]),
        signals: z
          .object({
            expectedOutputTokens: z.number().int().min(0).optional(),
            changedFiles: z.number().int().min(0).optional(),
            diffLines: z.number().int().min(0).optional(),
            failedAttempts: z.number().int().min(0).optional(),
            failingTests: z.boolean().optional(),
            touchesSecurity: z.boolean().optional(),
            touchesInfra: z.boolean().optional(),
            userRequestedCodex: z.boolean().optional(),
            hasHandoff: z.boolean().optional(),
            isTrivial: z.boolean().optional(),
            isDestructive: z.boolean().optional(),
            risk: z.enum(["low", "medium", "high", "critical"]).optional(),
          })
          .strict()
          .optional(),
      },
      annotations: {
        title: "Composer Codex Lifecycle Decide",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ event, signals }) => {
      const result = decideCodexLifecycle(
        ctx.getActiveConfig()?.codexLifecycle,
        event,
        signals,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    COMPOSER_CODEX_LIFECYCLE_RUN,
    {
      description: CODEX_LIFECYCLE_RUN_DESCRIPTION,
      inputSchema: {
        event: z.enum([
          "postResearch",
          "postPlan",
          "postCodeApply",
          "postTestFailure",
          "afterFailedAttempts",
          "preCommit",
          "stopWarm",
        ]),
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        objective: z.string().optional(),
        execution: z.enum(["foreground", "background"]).optional(),
        confirmed: z.boolean().optional(),
        projectDir: z.string().optional(),
        signals: z
          .object({
            expectedOutputTokens: z.number().int().min(0).optional(),
            changedFiles: z.number().int().min(0).optional(),
            diffLines: z.number().int().min(0).optional(),
            failedAttempts: z.number().int().min(0).optional(),
            failingTests: z.boolean().optional(),
            touchesSecurity: z.boolean().optional(),
            touchesInfra: z.boolean().optional(),
            userRequestedCodex: z.boolean().optional(),
            hasHandoff: z.boolean().optional(),
            isTrivial: z.boolean().optional(),
            isDestructive: z.boolean().optional(),
            risk: z.enum(["low", "medium", "high", "critical"]).optional(),
          })
          .strict()
          .optional(),
      },
      annotations: {
        title: "Composer Codex Lifecycle Run",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (
      { event, prompt, context, handoffPath, objective, execution, confirmed, projectDir, signals },
      extra,
    ) => {
      ctx.refreshConfigIfChanged();
      const lifecycleConfig = ctx.getActiveConfig()?.codexLifecycle;
      const resolvedLifecycle = resolveCodexLifecycle(lifecycleConfig);
      const policyDecision = decideCodexLifecycle(
        lifecycleConfig,
        event,
        signals,
      );
      const decision =
        confirmed === true && policyDecision.action === "ask"
          ? {
              ...policyDecision,
              action: "run" as const,
              reasons: [...policyDecision.reasons, "user confirmed Codex lifecycle ask"],
            }
          : policyDecision;
      const selectedExecution = execution ?? decision.execution;
      let job = newCodexLifecycleJob(root, {
        event,
        decision,
        execution: selectedExecution,
        handoffPath,
        objective,
      });
      job = writeCodexLifecycleJob(root, job);

      if (decision.action !== "run") {
        job = updateCodexLifecycleJob(root, job, {
          status: "skipped",
          completedAt: new Date().toISOString(),
          resultText: `Lifecycle policy returned ${decision.action}; Codex was not run.`,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
        };
      }

      let targetRoot: string | undefined;
      try {
        targetRoot = projectDir === undefined ? undefined : resolveProjectDir(projectDir, root);
      } catch (error) {
        job = updateCodexLifecycleJob(root, job, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
        };
      }
      const runner = (onProgress?: (update: { phase?: string; detail?: string }) => void) =>
        runCodexLifecycleJob({
          root,
          registry,
          job,
          prompt,
          context,
          handoffPath,
          projectDir: targetRoot,
          signal: selectedExecution === "foreground" ? extra.signal : undefined,
          fallback: resolvedLifecycle.fallback,
          maxTotalMs: resolvedLifecycle.totalWallClockMs,
          onProgress,
        });

      if (selectedExecution === "background") {
        void runner().catch(() => {
          // The runner persists its own failures to the durable job record;
          // this guard only prevents an unobserved promise rejection.
        });
        return {
          content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
        };
      }

      const provider = registry.getProviderForRole("coderCli");
      const completed = await withProgress(extra, COMPOSER_CODEX_LIFECYCLE_RUN, runner, {
        tracker: ctx.activeRuns,
        providerLabel: provider.modelLabel,
        providerRole: "coderCli",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(completed, null, 2) }],
      };
    },
  );

  server.registerTool(
    COMPOSER_CODEX_LIFECYCLE_RESULT,
    {
      description: CODEX_LIFECYCLE_RESULT_DESCRIPTION,
      inputSchema: {
        jobId: z.string().uuid().optional(),
      },
      annotations: {
        title: "Composer Codex Lifecycle Result",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ jobId }) => {
      const job = jobId
        ? readCodexLifecycleJob(root, jobId)
        : readLatestCodexLifecycleJob(root);
      const response = job ?? {
        found: false,
        jobId: jobId ?? null,
        message: jobId
          ? `No Codex lifecycle result found for ${jobId}.`
          : "No Codex lifecycle results found.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
