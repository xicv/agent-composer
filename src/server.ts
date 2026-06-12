// Wave 1 F2.1 — factory for the Composer MCP server (per §8 Day 1).
// Pure function: takes a ProviderRegistry, returns an unconnected McpServer
// with the three C0.3 tools registered. Test code connects via
// InMemoryTransport; src/index.ts connects via StdioServerTransport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderRegistry } from "./registry.js";
import { parseConfig } from "./config/loader.js";
import { globalConfigDir } from "./config/paths.js";
import {
  HANDOFF_DIR,
  formatHandoffForPrompt,
  newHandoffPacket,
  readHandoffPacket,
  writeHandoffPacket,
  type HandoffArtifact,
} from "./util/handoff.js";
import { decideCodexLifecycle } from "./util/codexLifecycle.js";
import {
  classifyCodexLifecycleUnavailable,
  newCodexLifecycleJob,
  readCodexLifecycleJob,
  readLatestCodexLifecycleJob,
  updateCodexLifecycleJob,
  writeCodexLifecycleJob,
  type CodexLifecycleJob,
} from "./util/codexLifecycleJob.js";
import {
  newOracleJob,
  readLatestOracleJob,
  readOracleJob,
  updateOracleJob,
  writeOracleJob,
  type OracleJob,
} from "./util/oracleJob.js";
import { acquireOracleLock } from "./util/oracleLock.js";
import type {
  CodexLifecycleFallback,
  ComposerConfig,
  RoleName,
} from "./config/schema.js";

// C0.3 — locked MCP tool names. Referenced by subagent allowlists +
// boundary_guard.sh; do not rename without a new ADR.
export const COMPOSER_RESEARCH = "composer_research" as const;
export const COMPOSER_CODE = "composer_code" as const;
export const COMPOSER_REVIEW = "composer_review" as const;
export const COMPOSER_REVIEW_CLAUDE = "composer_review_claude" as const;
export const COMPOSER_CODE_CLI = "composer_code_cli" as const;
export const COMPOSER_CODE_CHAIN = "composer_code_chain" as const;
export const COMPOSER_HANDOFF_CREATE = "composer_handoff_create" as const;
export const COMPOSER_CODEX_LIFECYCLE_DECIDE = "composer_codex_lifecycle_decide" as const;
export const COMPOSER_CODEX_LIFECYCLE_RUN = "composer_codex_lifecycle_run" as const;
export const COMPOSER_CODEX_LIFECYCLE_RESULT = "composer_codex_lifecycle_result" as const;
export const COMPOSER_CONFIG_GET = "composer_config_get" as const;
export const COMPOSER_CONFIG_SET = "composer_config_set" as const;
export const COMPOSER_ORACLE_PLAN = "composer_oracle_plan" as const;
export const COMPOSER_ORACLE_JOB_START = "composer_oracle_job_start" as const;
export const COMPOSER_ORACLE_JOB_RESULT = "composer_oracle_job_result" as const;

const RESEARCH_DESCRIPTION =
  "Default off-CC research lane for documentation lookup, web search, " +
  "current API shape, and external context. Returns a bounded summary; call " +
  "directly unless raw upstream output needs separate subagent isolation.";

const CODE_DESCRIPTION =
  "LEGACY patch-only GLM authoring lane. Use only when you explicitly need " +
  "GLM to return a diff/text WITHOUT applying files. For normal code writing, " +
  "refactoring, debugging, and implementation, prefer composer_code_cli " +
  "(default) or composer_code_chain (GLM complete-file fallback).";

const CODE_CHAIN_DESCRIPTION =
  "Preferred for substantial code: GLM AUTHORS the code (off-CC), then the " +
  "Composer server APPLIES it to disk deterministically (off-CC), then gate it through " +
  "composer_review. The orchestrator only calls this once and relays the " +
  "summary — it never generates or writes code itself. Combines GLM code " +
  "quality with off-CC application (keeps the main session lean). Returns a " +
  "summary of files written.";

const CODE_CLI_DESCRIPTION =
  "Generate AND APPLY code changes directly to disk via the CLI executor " +
  "(Codex/agy/Gemini), which runs in the server working directory and edits files " +
  "itself. Returns ONLY a summary of what changed. Use this to offload BOTH " +
  "generation and file-writing off the main session: the orchestrator does " +
  "NOT call Edit/Write — the executor already applied the changes. Prefer " +
  "this for multi-file or substantial edits to keep the main context lean.";

const REVIEW_DESCRIPTION =
  "Default off-CC review lane for diff critique and bug-finding before " +
  "integration. Provide the diff inline and ask for repo-appropriate targeted " +
  "checks. Returns a bounded summary; call directly unless raw output needs " +
  "separate subagent isolation.";

const REVIEW_CLAUDE_DESCRIPTION =
  "Premium Claude review lane for high-risk diffs, security-sensitive changes, " +
  "or when the user explicitly asks for Claude review. Keep composer_review " +
  "as the default gate; call this directly as a second-opinion escalation.";

const HANDOFF_CREATE_DESCRIPTION =
  "Create a shared, provider-neutral handoff packet under .composer/handoffs. " +
  "Use this before multi-agent or multi-provider work so Codex, GLM, agy, " +
  "and reviewers receive the same compact objective, constraints, files, " +
  "decisions, and acceptance criteria without copying the full transcript.";

const CODEX_LIFECYCLE_DECIDE_DESCRIPTION =
  "Deterministically decide whether Codex should participate in a lifecycle " +
  "step (plan, code-apply, test-failure, failed attempts, or passive warm " +
  "checks). This is policy-only: it never invokes Codex and returns a compact " +
  "JSON decision so Coco can skip, ask, or run within codexLifecycle config.";

const CODEX_LIFECYCLE_RUN_DESCRIPTION =
  "Run a Codex lifecycle companion pass and persist a durable result record. " +
  "Foreground execution returns the result immediately; background execution " +
  "returns a jobId/resultPath that composer_codex_lifecycle_result can read " +
  "later. The companion pass is advisory and must not silently mutate files.";

const CODEX_LIFECYCLE_RESULT_DESCRIPTION =
  "Read a durable Codex lifecycle result by jobId, or the latest lifecycle " +
  "result when jobId is omitted. Use this to bring background Codex output " +
  "back into the main development loop.";

const CONFIG_GET_DESCRIPTION =
  "Read the active, project, or global Composer config path and validated " +
  "config. Use this before changing Composer behavior from Claude Code.";

const CONFIG_SET_DESCRIPTION =
  "Safely update Composer config toggles from Claude Code. Supports Codex " +
  "lifecycle, lifecycle fallback, and pre-commit review gate settings; validates " +
  "the resulting composer.config.json before writing.";

const ORACLE_PLAN_DESCRIPTION =
  "Opt-in planning/review/debug lane backed by ChatGPT Pro through the " +
  "Oracle browser (scripts/oracle-pro-safe.sh). Use for architecture, " +
  "feature planning, migration design, hard root-cause debugging, or " +
  "high-risk review when you want extended reasoning from ChatGPT Pro. " +
  "The `mode` argument selects thinking depth (quick|standard|deep|plan|" +
  "review|debug|research); omit or use auto to let the script classify. " +
  "Returns a bounded summary; the full answer is saved under " +
  ".composer/oracle/answers/. Advisory planning only — file edits still go " +
  "through composer_code_cli.";

const ORACLE_JOB_START_DESCRIPTION =
  "Start a NON-BLOCKING ChatGPT Pro (Oracle) job and return a jobId " +
  "immediately. Use for long deep-research or large architectural/review " +
  "runs, or when the user explicitly says not to block. For normal " +
  "planning that the next step depends on, prefer the synchronous " +
  "composer_oracle_plan instead. Poll composer_oracle_job_result with the " +
  "jobId to retrieve the answer. Advisory only — never edits files.";

const ORACLE_JOB_RESULT_DESCRIPTION =
  "Read a durable Oracle job by jobId (or the latest when omitted). " +
  "Returns status (queued|running|succeeded|failed) and, when succeeded, " +
  "the bounded answer text. Optional waitMs briefly blocks until the job " +
  "reaches a terminal state or the wait elapses.";

/**
 * Deterministically apply GLM-authored output of the form
 *   FILE: <relative/path>
 *   ```lang
 *   <content>
 *   ```
 * Writes each file under `root` (cwd/projectDir). Guards against path
 * traversal, including symlink escapes through existing parent directories.
 */
export function applyFileBlocks(
  text: string,
  root: string,
): { files: Array<{ path: string; status: "changed" | "unchanged" }>; rejected: string[] } {
  const projectRoot = fs.realpathSync(root);
  const parsed: Array<{ rel: string; abs: string; content: string }> = [];
  const rejected: string[] = [];
  const re = /^FILE:\s*(\S+)[^\n]*\r?\n(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)^\2[ \t]*$(?=\r?\nFILE:\s|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rel = (m[1] ?? "").trim();
    const content = m[3] ?? "";
    if (!rel) continue;
    const abs = path.resolve(projectRoot, rel);
    if (!isPathInside(abs, projectRoot)) {
      rejected.push(`${rel} (outside projectDir)`);
      continue;
    }
    const nearestParent = nearestExistingParent(path.dirname(abs));
    const parentReal = fs.realpathSync(nearestParent);
    if (!isPathInside(parentReal, projectRoot)) {
      rejected.push(`${rel} (parent resolves outside projectDir)`);
      continue;
    }
    let leafStat: fs.Stats | undefined;
    try {
      leafStat = fs.lstatSync(abs);
    } catch {
      leafStat = undefined;
    }
    if (leafStat?.isSymbolicLink()) {
      // A symlink leaf (including a DANGLING one) would be followed by
      // writeFileSync and could escape projectDir. realpathSync throws on a
      // dangling target, so reject unresolvable or escaping links.
      let linkReal: string | undefined;
      try {
        linkReal = fs.realpathSync(abs);
      } catch {
        linkReal = undefined;
      }
      if (linkReal === undefined || !isPathInside(linkReal, projectRoot)) {
        rejected.push(`${rel} (symlink target resolves outside projectDir)`);
        continue;
      }
    } else if (leafStat !== undefined) {
      const existingReal = fs.realpathSync(abs);
      if (!isPathInside(existingReal, projectRoot)) {
        rejected.push(`${rel} (file resolves outside projectDir)`);
        continue;
      }
    }
    parsed.push({ rel, abs, content });
  }

  if (rejected.length > 0) {
    throw new Error(
      `composer_code_chain: refusing to apply paths outside projectDir ${projectRoot}: ${rejected.join(", ")}`,
    );
  }

  // Two-phase apply so a mid-write failure cannot leave partial state:
  // stage every CHANGED file to a sibling temp, then atomically rename all.
  const statusByRel = new Map<string, "changed" | "unchanged">();
  const pending: Array<{ abs: string; tmp: string }> = [];
  try {
    for (const { rel, abs, content } of parsed) {
      const previous = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
      if (previous === content) {
        statusByRel.set(rel, "unchanged");
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = path.join(
        path.dirname(abs),
        `.composer-apply-${process.pid}-${pending.length}.tmp`,
      );
      fs.writeFileSync(tmp, content, "utf8");
      pending.push({ abs, tmp });
      statusByRel.set(rel, "changed");
    }
  } catch (error) {
    for (const { tmp } of pending) fs.rmSync(tmp, { force: true });
    throw error;
  }
  // Phase 2: rename staged temps into place, snapshotting each target's prior
  // content first so a mid-phase failure can roll back to the original state.
  const applied: Array<{ abs: string; original: string | null }> = [];
  try {
    for (const { abs, tmp } of pending) {
      const original = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      fs.renameSync(tmp, abs);
      applied.push({ abs, original });
    }
  } catch (error) {
    // Roll back already-applied files (restore prior content, or remove files
    // that did not previously exist), then clean up any remaining temps.
    for (const done of applied.reverse()) {
      try {
        if (done.original === null) {
          fs.rmSync(done.abs, { force: true });
        } else {
          fs.writeFileSync(done.abs, done.original, "utf8");
        }
      } catch {
        // best-effort restore; nothing else we can safely do here
      }
    }
    for (const { tmp } of pending) fs.rmSync(tmp, { force: true });
    throw error;
  }
  const files = parsed.map(({ rel }) => ({
    path: rel,
    status: statusByRel.get(rel) ?? "unchanged",
  }));
  return { files, rejected };
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function nearestExistingParent(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function resolveProjectDir(projectDir: string | undefined, root: string): string {
  const resolved = projectDir === undefined ? root : path.resolve(projectDir);
  if (projectDir !== undefined && !path.isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path: ${projectDir}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`projectDir must be an existing directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

export interface ComposerServerOptions {
  root?: string;
  config?: ComposerConfig;
  configPath?: string;
}

export function createComposerServer(
  registry: ProviderRegistry,
  options: ComposerServerOptions = {},
): McpServer {
  const root = path.resolve(options.root ?? process.cwd());
  let activeConfig = options.config;
  const server = new McpServer({
    name: "composer",
    version: "0.0.0",
  });

  // Per advisor pass 2026-05-23: tool annotations signal behaviour to the
  // orchestrator without changing execution. readOnlyHint / openWorldHint /
  // destructiveHint / idempotentHint are append-only per ADR 0001.

  server.registerTool(
    COMPOSER_RESEARCH,
    {
      description: RESEARCH_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Research",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("researcher");
      const result = await withProgress(extra, COMPOSER_RESEARCH, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

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
      const provider = registry.getProviderForRole("oraclePlanner");
      const effectivePrompt =
        mode && mode !== "auto" ? `[oracle:${mode}] ${prompt}` : prompt;
      const lock = acquireOracleLock(root, { label: "oracle_plan" });
      if (!lock.acquired) {
        throw new Error(
          `Oracle is busy: a run is already in progress (pid ${lock.holder.pid}` +
            `${lock.holder.jobId ? `, job ${lock.holder.jobId}` : ""}). ` +
            `Retry shortly, or use composer_oracle_job_start for a queued async run.`,
        );
      }
      try {
        const result = await withProgress(extra, COMPOSER_ORACLE_PLAN, () =>
          provider.execute({
            prompt: effectivePrompt,
            context: contextWithHandoff(root, context, handoffPath),
            cwd: root,
            signal: extra.signal,
          }),
        );
        return { content: [{ type: "text", text: result.text }] };
      } finally {
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
      const resolvedMode = mode ?? "auto";
      const provider = registry.getProviderForRole("oraclePlanner");
      const lock = acquireOracleLock(root, { label: "oracle_job_start" });
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
      let job: OracleJob;
      try {
        job = newOracleJob(root, {
          mode: resolvedMode,
          promptPreview: prompt.slice(0, 200),
          handoffPath,
        });
        job = writeOracleJob(root, job);
      } catch (error) {
        lock.handle.release();
        throw error;
      }
      const effectivePrompt =
        resolvedMode !== "auto" ? `[oracle:${resolvedMode}] ${prompt}` : prompt;
      const runner = async () => {
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
    async ({ jobId, waitMs }) => {
      const deadline = Date.now() + (waitMs ?? 0);
      const read = () => (jobId ? readOracleJob(root, jobId) : readLatestOracleJob(root));
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
        message: jobId ? `No Oracle job found for ${jobId}.` : "No Oracle jobs found.",
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE,
    {
      description: CODE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Code",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("coder");
      const result = await withProgress(extra, COMPOSER_CODE, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW,
    {
      description: REVIEW_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Review",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("reviewer");
      const result = await withProgress(extra, COMPOSER_REVIEW, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, diff, handoffPath),
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_CLAUDE,
    {
      description: REVIEW_CLAUDE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Review (Claude Premium)",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath }, extra) => {
      const provider = registry.getProviderForRole("reviewerClaude");
      const result = await withProgress(extra, COMPOSER_REVIEW_CLAUDE, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, diff, handoffPath),
          cwd: root,
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CHAIN,
    {
      description: CODE_CHAIN_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        projectDir: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (GLM author -> CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath, projectDir }, extra) => {
      const targetRoot = resolveProjectDir(projectDir, root);
      // Stage 1: GLM authors the code off-CC (returns full file contents).
      const gen = registry.getProviderForRole("coder");
      const genPrompt =
        prompt +
        `\n\nTARGET PROJECT DIR: ${targetRoot}. All FILE paths must be relative to this directory.` +
        "\n\nOUTPUT FORMAT: give the COMPLETE contents of every file to " +
        "create or modify. For each file, write a line `FILE: <relative/path>` " +
        "followed by a fenced code block with the full file content. Use " +
        "four-backtick fences when file content may contain triple-backtick " +
        "blocks. No " +
        "abbreviations, no placeholders, no commentary outside the blocks.";
      const authored = await withProgress(extra, COMPOSER_CODE_CHAIN, () =>
        gen.execute({
          prompt: genPrompt,
          context: contextWithHandoff(root, context, handoffPath),
          cwd: targetRoot,
          signal: extra.signal,
        }),
      );

      // Stage 2: server applies GLM's FILE: blocks deterministically (off-CC,
      // no LLM transcription step — an executor cannot fabricate the apply).
      const { files } = applyFileBlocks(authored.text, targetRoot);
      const changed = files.filter((file) => file.status === "changed");
      if (changed.length === 0) {
        throw new Error(
          `composer_code_chain: apply produced no changes — check projectDir (server cwd is ${process.cwd()}, target was ${targetRoot}); nothing was modified`,
        );
      }
      const summary =
        `GLM authored + applied off-CC in projectDir ${targetRoot}. ` +
        `Changed ${changed.length}/${files.length} file(s): ` +
        files.map((file) => `${file.path}=${file.status}`).join(", ") + ".";
      return { content: [{ type: "text", text: summary }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CLI,
    {
      description: CODE_CLI_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
        projectDir: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath, projectDir }, extra) => {
      const targetRoot = resolveProjectDir(projectDir, root);
      const provider = registry.getProviderForRole("coderCli");
      const result = await withProgress(extra, COMPOSER_CODE_CLI, () =>
        provider.execute({
          prompt,
          context: contextWithHandoff(root, context, handoffPath),
          cwd: root,
          projectDir: projectDir === undefined ? undefined : targetRoot,
          signal: extra.signal,
        }),
      );
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_HANDOFF_CREATE,
    {
      description: HANDOFF_CREATE_DESCRIPTION,
      inputSchema: {
        objective: z.string().min(1),
        contextSummary: z.string().optional(),
        constraints: z.array(z.string().min(1)).optional(),
        relevantFiles: z.array(z.string().min(1)).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        decisions: z.array(z.string().min(1)).optional(),
        openQuestions: z.array(z.string().min(1)).optional(),
        artifacts: z
          .array(
            z.object({
              kind: z.enum(["research", "code", "review", "test", "note"]),
              summary: z.string().min(1),
              path: z.string().min(1).optional(),
              source: z.string().min(1).optional(),
            }),
          )
          .optional(),
        briefPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Handoff Create",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({
      objective,
      contextSummary,
      constraints,
      relevantFiles,
      acceptanceCriteria,
      decisions,
      openQuestions,
      artifacts,
      briefPath,
    }) => {
      const packet = newHandoffPacket({
        objective,
        contextSummary,
        constraints,
        relevantFiles,
        acceptanceCriteria,
        decisions,
        openQuestions,
        artifacts: artifacts as HandoffArtifact[] | undefined,
        briefPath,
      });
      const handoffPath = writeHandoffPacket(
        packet,
        path.resolve(root, HANDOFF_DIR),
      );
      const response = {
        runId: packet.runId,
        handoffPath,
        objective: packet.objective,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );

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
        activeConfig?.codexLifecycle,
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
      const policyDecision = decideCodexLifecycle(
        activeConfig?.codexLifecycle,
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
      const runner = () =>
        runCodexLifecycleJob({
          root,
          registry,
          job,
          prompt,
          context,
          handoffPath,
          projectDir: targetRoot,
          signal: selectedExecution === "foreground" ? extra.signal : undefined,
          fallback: activeConfig?.codexLifecycle?.fallback,
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

      const completed = await withProgress(extra, COMPOSER_CODEX_LIFECYCLE_RUN, runner);
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

  server.registerTool(
    COMPOSER_CONFIG_GET,
    {
      description: CONFIG_GET_DESCRIPTION,
      inputSchema: {
        scope: z.enum(["active", "project", "global"]).optional(),
      },
      annotations: {
        title: "Composer Config Get",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ scope }) => {
      const target = resolveComposerConfigTarget(root, options.configPath, scope ?? "active");
      const response = fs.existsSync(target.path)
        ? {
            ...target,
            exists: true,
            config: parseConfig(JSON.parse(fs.readFileSync(target.path, "utf8"))),
          }
        : {
            ...target,
            exists: false,
            config: null,
          };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.registerTool(
    COMPOSER_CONFIG_SET,
    {
      description: CONFIG_SET_DESCRIPTION,
      inputSchema: {
        scope: z.enum(["active", "project", "global"]).optional(),
        dryRun: z.boolean().optional(),
        codexLifecycle: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(["ask", "auto"]).optional(),
            execution: z.enum(["foreground", "background"]).optional(),
            model: z.string().min(1).optional(),
            triggers: z
              .object({
                postResearch: z.boolean().optional(),
                postPlan: z.boolean().optional(),
                postCodeApply: z.boolean().optional(),
                postTestFailure: z.boolean().optional(),
                afterFailedAttempts: z.boolean().optional(),
                preCommit: z.boolean().optional(),
                stopWarm: z.boolean().optional(),
              })
              .strict()
              .optional(),
            thresholds: z
              .object({
                minScore: z.number().min(0).max(100).optional(),
                minExpectedOutputTokens: z.number().int().min(1).optional(),
                minChangedFiles: z.number().int().min(1).optional(),
                minDiffLines: z.number().int().min(1).optional(),
                failedAttempts: z.number().int().min(1).optional(),
              })
              .strict()
              .optional(),
            fallback: z
              .object({
                enabled: z.boolean().optional(),
                order: z
                  .array(z.enum(["researcher", "coder", "reviewer", "reviewerClaude", "coderCli"]))
                  .min(1)
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        codexReview: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(["ask", "auto"]).optional(),
            execution: z.enum(["foreground", "background"]).optional(),
            scope: z.enum(["auto", "working-tree", "branch"]).optional(),
            base: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            triggers: z
              .object({
                preCommit: z.boolean().optional(),
                postPlan: z.boolean().optional(),
              })
              .strict()
              .optional(),
            preCommitHook: z
              .object({
                enabled: z.boolean().optional(),
                blockOnSeverity: z.enum(["critical", "high", "medium", "low"]).optional(),
                timeoutMs: z.number().int().min(1).optional(),
                failClosed: z.boolean().optional(),
              })
              .strict()
              .optional(),
            warmCache: z
              .object({
                enabled: z.boolean().optional(),
                maxAgeMinutes: z.number().int().min(1).optional(),
                timeoutMs: z.number().int().min(1).optional(),
              })
              .strict()
              .optional(),
            notify: z
              .object({
                desktop: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      },
      annotations: {
        title: "Composer Config Set",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ scope, dryRun, codexLifecycle, codexReview }) => {
      const requestedScope = scope ?? "active";
      const target = resolveComposerConfigTarget(root, options.configPath, requestedScope);
      if (requestedScope === "active" && isGlobalComposerConfigPath(target.path)) {
        throw new Error(
          'Active Composer config resolves to the user-global config; use scope:"global" explicitly to mutate it.',
        );
      }
      if (!fs.existsSync(target.path)) {
        throw new Error(`Composer config target does not exist: ${target.path}`);
      }
      const beforeRaw = fs.readFileSync(target.path, "utf8");
      const before = JSON.parse(beforeRaw) as Record<string, unknown>;
      const next = applyComposerConfigPatch(before, { codexLifecycle, codexReview });
      const parsed = parseConfig(next);
      const nextRaw = `${JSON.stringify(parsed, null, 2)}\n`;
      const changed = beforeRaw !== nextRaw;
      const activeTarget = resolveComposerConfigTarget(root, options.configPath, "active");

      if (!dryRun && changed) {
        assertSafeConfigWriteTarget(root, target);
        writeConfigFileAtomically(target.path, nextRaw);
      }
      if (!dryRun && target.path === activeTarget.path) {
        activeConfig = parsed;
      }

      const response = {
        ...target,
        dryRun: dryRun === true,
        changed,
        config: parsed,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  return server;
}

type ConfigScope = "active" | "project" | "global";

interface ComposerConfigTarget {
  scope: ConfigScope;
  path: string;
}

function resolveComposerConfigTarget(
  root: string,
  configuredPath: string | undefined,
  scope: ConfigScope,
): ComposerConfigTarget {
  if (scope === "project") {
    return { scope, path: path.resolve(root, "composer.config.json") };
  }
  if (scope === "global") {
    return { scope, path: path.join(globalConfigDir(), "composer.config.json") };
  }

  if (configuredPath && configuredPath.length > 0) {
    const configuredTarget = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(root, configuredPath);
    if (fs.existsSync(configuredTarget)) {
      return { scope, path: configuredTarget };
    }
    if (!path.isAbsolute(configuredPath)) {
      const globalTarget = path.join(globalConfigDir(), configuredPath);
      if (fs.existsSync(globalTarget)) {
        return { scope, path: globalTarget };
      }
    }
    return {
      scope,
      path: configuredTarget,
    };
  }

  const projectPath = path.resolve(root, "composer.config.json");
  if (fs.existsSync(projectPath)) return { scope, path: projectPath };
  return { scope, path: path.join(globalConfigDir(), "composer.config.json") };
}

function applyComposerConfigPatch(
  before: Record<string, unknown>,
  patch: {
    codexLifecycle?: unknown;
    codexReview?: unknown;
  },
): Record<string, unknown> {
  const next = cloneJsonObject(before);
  if (patch.codexLifecycle !== undefined) {
    next["codexLifecycle"] = deepMergeRecords(
      readRecord(next["codexLifecycle"]),
      readRecord(patch.codexLifecycle),
    );
  }
  if (patch.codexReview !== undefined) {
    next["codexReview"] = deepMergeRecords(
      readRecord(next["codexReview"]),
      readRecord(patch.codexReview),
    );
  }
  return next;
}

function assertSafeConfigWriteTarget(root: string, target: ComposerConfigTarget): void {
  const stat = fs.lstatSync(target.path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Composer config target must not be a symlink: ${target.path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Composer config target must be a file: ${target.path}`);
  }

  if (target.scope === "project") {
    const rootReal = fs.realpathSync(root);
    const parentReal = fs.realpathSync(path.dirname(target.path));
    if (!isPathInside(parentReal, rootReal)) {
      throw new Error(`Composer project config target escapes project root: ${target.path}`);
    }
  }
}

function writeConfigFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.composer-config-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function isGlobalComposerConfigPath(filePath: string): boolean {
  return path.resolve(filePath) === path.join(globalConfigDir(), "composer.config.json");
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? cloneJsonObject(value) : {};
}

function deepMergeRecords(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneJsonObject(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = next[key];
    next[key] =
      isRecord(existing) && isRecord(value)
        ? deepMergeRecords(existing, value)
        : value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RunCodexLifecycleJobInput {
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

async function runCodexLifecycleJob(
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

function lifecycleProviderRoles(fallback: CodexLifecycleFallback | undefined): RoleName[] {
  const roles: RoleName[] = ["coderCli"];
  if (fallback?.enabled) {
    for (const role of fallback.order) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

function lifecycleExecutionTarget(
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

function codexLifecyclePrompt(job: CodexLifecycleJob, prompt: string, role: RoleName): string {
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

function contextWithHandoff(
  root: string,
  context?: string,
  handoffPath?: string,
): string | undefined {
  const blocks: string[] = [];
  if (handoffPath) {
    const handoff = readHandoffPacket(handoffPath, root);
    blocks.push(formatHandoffForPrompt(handoff));
  }
  if (context) blocks.push(context);
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

type ToolProgressExtra = {
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
};

async function withProgress<T>(
  extra: ToolProgressExtra,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const reporter = createProgressReporter(extra, label);
  await reporter.report("started");
  try {
    const result = await work();
    await reporter.report("completed");
    return result;
  } catch (error) {
    await reporter.report("failed");
    throw error;
  } finally {
    reporter.stop();
  }
}

function createProgressReporter(extra: ToolProgressExtra, label: string) {
  const progressToken = extra._meta?.progressToken;
  let progress = 0;
  let active = true;

  const report = async (state: string) => {
    if (!active || progressToken === undefined || !extra.sendNotification) {
      return;
    }
    progress += 1;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: `${label} ${state}`,
        },
      });
    } catch {
      // Progress is advisory; never fail the tool because a client ignores it.
    }
  };

  const timer =
    progressToken !== undefined && extra.sendNotification
      ? setInterval(() => {
          void report("still running");
        }, 30_000)
      : undefined;

  return {
    report,
    stop: () => {
      active = false;
      if (timer) clearInterval(timer);
    },
  };
}
