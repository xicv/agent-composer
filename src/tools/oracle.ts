import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { withProgress } from "../server/progress.js";
import { contextWithHandoff } from "../server/handoffContext.js";
import {
  COMPOSER_ORACLE_PLAN,
  COMPOSER_ORACLE_JOB_START,
  COMPOSER_ORACLE_JOB_RESULT,
  ORACLE_PLAN_DESCRIPTION,
  ORACLE_JOB_START_DESCRIPTION,
  ORACLE_JOB_RESULT_DESCRIPTION,
} from "../server/toolDescriptions.js";
import {
  newOracleJob,
  readLatestOracleJob,
  readOracleJob,
  updateOracleJob,
  writeOracleJob,
} from "../util/oracleJob.js";
import { acquireOracleLock, type OracleLockRecovery } from "../util/oracleLock.js";
import { DEFAULT_ANTHROPIC_TIMEOUT_MS } from "../providers/AnthropicCompatibleProvider.js";
import { createDeadlineSignal } from "../util/asyncControl.js";
import { pollJobResult } from "../util/jobPolling.js";
import type { ServerToolContext } from "./context.js";

const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = DEFAULT_ANTHROPIC_TIMEOUT_MS;

export function registerOracleTools(ctx: ServerToolContext): void {
  const { server, registry, root } = ctx;

  server.registerTool(
    COMPOSER_ORACLE_PLAN,
    {
      description: ORACLE_PLAN_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        mode: z
          .enum([
            "auto",
            "quick",
            "standard",
            "deep",
            "plan",
            "review",
            "debug",
            "research",
          ])
          .optional(),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Oracle Plan (ChatGPT Pro)",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, mode, context, handoffPath }, extra) => {
      ctx.refreshConfigIfChanged();
      const provider = registry.getProviderForRole("oraclePlanner");
      const cfgOracle = ctx.getActiveConfig()?.oracle;
      const sessOracle = ctx.getSession().oracle;
      const oracleCfg = {
        defaultMode: sessOracle?.defaultMode ?? cfgOracle?.defaultMode,
        requireExplicitTag: sessOracle?.requireExplicitTag ?? cfgOracle?.requireExplicitTag,
      };
      const resolvedMode = mode ?? oracleCfg?.defaultMode ?? "auto";
      if (
        oracleCfg?.requireExplicitTag === true &&
        resolvedMode === "auto" &&
        !/\[oracle:(quick|standard|deep|plan|review|debug|research)\]/i.test(prompt)
      ) {
        throw new Error(
          "composer_oracle_plan: oracle.requireExplicitTag is set — pass an explicit mode (quick|standard|deep|plan|review|debug|research) or tag the prompt with [oracle:<mode>].",
        );
      }
      const effectivePrompt =
        resolvedMode !== "auto" ? `[oracle:${resolvedMode}] ${prompt}` : prompt;
      const lock = acquireOracleLock(root, { label: "oracle_plan" });
      emitOracleLockRecovery(lock.recovery);
      if (!lock.acquired) {
        throw new Error(
          `Oracle is busy: a run is already in progress (pid ${lock.holder.pid}` +
            `${lock.holder.jobId ? `, job ${lock.holder.jobId}` : ""}). ` +
            `Retry shortly, or use composer_oracle_job_start for a queued async run.`,
        );
      }
      const toolSignal = createBoundedSignal(
        COMPOSER_ORACLE_PLAN,
        resolveRoleTimeoutMs(ctx.getActiveConfig()?.roles.oraclePlanner?.timeoutMs),
        extra.signal,
      );
      try {
        const result = await withProgress(extra, COMPOSER_ORACLE_PLAN, () =>
          provider.execute({
            prompt: effectivePrompt,
            context: contextWithHandoff(root, context, handoffPath),
            cwd: root,
            signal: toolSignal.signal,
          }),
          { tracker: ctx.activeRuns },
        );
        return { content: [{ type: "text", text: result.text }] };
      } finally {
        toolSignal.cleanup();
        lock.handle.release();
      }
    },
  );

  server.registerTool(
    COMPOSER_ORACLE_JOB_START,
    {
      description: ORACLE_JOB_START_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        mode: z.enum(["auto", "quick", "standard", "deep", "plan", "review", "debug", "research"]).optional(),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Oracle Job Start (async ChatGPT Pro)",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, mode, context, handoffPath }) => {
      ctx.refreshConfigIfChanged();
      const cfgOracle = ctx.getActiveConfig()?.oracle;
      const sessOracle = ctx.getSession().oracle;
      const oracleCfg = {
        defaultMode: sessOracle?.defaultMode ?? cfgOracle?.defaultMode,
        requireExplicitTag: sessOracle?.requireExplicitTag ?? cfgOracle?.requireExplicitTag,
      };
      const resolvedMode = mode ?? oracleCfg?.defaultMode ?? "auto";
      if (
        oracleCfg?.requireExplicitTag === true &&
        resolvedMode === "auto" &&
        !/\[oracle:(quick|standard|deep|plan|review|debug|research)\]/i.test(prompt)
      ) {
        throw new Error(
          "composer_oracle_job_start: oracle.requireExplicitTag is set — pass an explicit mode (quick|standard|deep|plan|review|debug|research) or tag the prompt with [oracle:<mode>].",
        );
      }
      const provider = registry.getProviderForRole("oraclePlanner");
      const jobTimeoutMs = resolveRoleTimeoutMs(
        ctx.getActiveConfig()?.roles.oraclePlanner?.timeoutMs,
      );
      let job = newOracleJob(root, {
        mode: resolvedMode,
        promptPreview: prompt.slice(0, 200),
        handoffPath,
      });
      const lock = acquireOracleLock(root, { jobId: job.jobId, label: "oracle_job_start" });
      emitOracleLockRecovery(lock.recovery);
      if (!lock.acquired) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "rejected",
                  reason: "an Oracle run is already in progress",
                  runningJobId: lock.holder.jobId ?? null,
                  holderPid: lock.holder.pid,
                  hint: "poll composer_oracle_job_result, or retry once the current run finishes",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        job = writeOracleJob(root, job);
      } catch (error) {
        lock.handle.release();
        throw error;
      }
      const effectivePrompt =
        resolvedMode !== "auto" ? `[oracle:${resolvedMode}] ${prompt}` : prompt;
      const runner = async () => {
        const jobSignal = createBoundedSignal(
          "composer_oracle_job_start",
          jobTimeoutMs,
        );
        try {
          const running = updateOracleJob(root, job, {
            status: "running",
            startedAt: new Date().toISOString(),
          });
          try {
            const result = await provider.execute({
              prompt: effectivePrompt,
              context: contextWithHandoff(root, context, handoffPath),
              cwd: root,
              signal: jobSignal.signal,
            });
            let answerMeta: { answerPath?: string; oracleSlug?: string } = {};
            try {
              const metaPath = path.join(root, ".composer", "oracle", "answers", ".last-plan-meta.json");
              if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
                  answerPath?: unknown;
                  oracleSlug?: unknown;
                };
                if (typeof meta.answerPath === "string") answerMeta.answerPath = meta.answerPath;
                if (typeof meta.oracleSlug === "string") answerMeta.oracleSlug = meta.oracleSlug;
              }
            } catch {
              // best-effort: missing/unreadable sidecar just means no answerPath
            }
            updateOracleJob(root, running, {
              status: "succeeded",
              completedAt: new Date().toISOString(),
              answerText: result.text,
              ...answerMeta,
            });
          } catch (error) {
            updateOracleJob(root, running, {
              status: "failed",
              completedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          jobSignal.cleanup();
          lock.handle.release();
        }
      };
      void runner().catch(() => {
        // The runner persists its own failures to the durable job record;
        // this guard only prevents an unobserved promise rejection.
      });
      return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    },
  );

  server.registerTool(
    COMPOSER_ORACLE_JOB_RESULT,
    {
      description: ORACLE_JOB_RESULT_DESCRIPTION,
      inputSchema: {
        jobId: z.string().uuid().optional(),
        waitMs: z.number().int().min(0).max(600000).optional(),
      },
      annotations: {
        title: "Composer Oracle Job Result",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ jobId, waitMs }, extra) => {
      const read = () => (jobId ? readOracleJob(root, jobId) : readLatestOracleJob(root));
      const job = await pollJobResult(read, {
        waitMs,
        signal: extra.signal,
        label: COMPOSER_ORACLE_JOB_RESULT,
      });
      const response = job ?? {
        found: false,
        jobId: jobId ?? null,
        message: jobId ? `No Oracle job found for ${jobId}.` : "No Oracle jobs found.",
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    },
  );
}

function emitOracleLockRecovery(recovery: OracleLockRecovery | undefined): void {
  if (!recovery) return;
  const payload = {
    reason_code: recovery.reasonCode,
    stage: recovery.stage,
    elapsed_wall_ms: recovery.elapsedWallMs,
    lock_age_ms: recovery.lockAgeMs,
    holder_pid: recovery.holder.pid,
    holder_job_id: recovery.holder.jobId ?? null,
    holder_label: recovery.holder.label ?? null,
  };
  console.error(JSON.stringify(payload));
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
  return createDeadlineSignal(label, timeoutMs, callerSignal);
}
