// Standalone live measure-only driver. Runs each eval task (with bounded
// warmup-retry) through a real headless `claude -p`, parses stream-json, and
// scores against committed baselines. NO mutation, NO /evolve.
//
//   tsx evals/scripts/measure.ts [--model sonnet] [--task t1-slugify]
//        [--budget-usd 0.5] [--warmup-retries 1] [--composer-entry <path>]
//
// METRIC SCOPE (critical): scores on TOTAL CC TOKENS = every Claude model in
// the run's modelUsage (orchestrator + subagents), because all of them burn
// the user's CC/Max5 quota. GLM work is tracked SEPARATELY (off-CC, via the
// composer GLM telemetry log) — it is the offload target, not a CC cost.
// Counting only the orchestrator (the old `usage` envelope) hides the win:
// when GLM generates code, the CC coder subagent only APPLIES it (cheap) vs
// GENERATING it (expensive) — the saving lives in the subagent, not the brain.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import {
  extractToolUseDispatchSequence,
  checkSuccess,
  type ToolUseBlock,
} from "../../scripts/run-evolve.js";
import {
  scoreTask,
  aggregateScore,
  evaluateDispatch,
  type TaskScore,
} from "../../tests/eval/metric.js";
import {
  EvalTaskSchema,
  type EvalTask,
  type EvalResult,
  type SubagentRole,
} from "../../tests/eval/schema.js";
import baselinesJson from "../baselines.json" with { type: "json" };

const CLEAN_BEFORE: Record<string, ReadonlyArray<string>> = {
  "t1-slugify": ["src/util/slug.ts"],
};
const INSTALLED_ENTRY =
  "/opt/homebrew/lib/node_modules/agent-composer/dist/index.js";
const GLM_LOG = "/tmp/composer-glm-usage.jsonl";

interface BaselineEntry {
  mainSessionTokens: number;
  wallSeconds?: number;
}
interface BaselinesFile {
  baselines: Record<string, BaselineEntry>;
  claudeModel?: string;
  claudeCodeVersion?: string;
}
const baselines = baselinesJson as unknown as BaselinesFile;

interface Args {
  model: string;
  taskFilter?: string;
  budgetUsd: number;
  warmupRetries: number;
  composerEntry?: string;
  runs: number;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let model = "sonnet";
  let taskFilter: string | undefined;
  let budgetUsd = 0.5;
  let warmupRetries = 1;
  let composerEntry: string | undefined;
  let runs = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--model requires a value");
      model = v;
    } else if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--task requires a value");
      taskFilter = v;
    } else if (a === "--budget-usd") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--budget-usd requires a value");
      const n = parseFloat(v);
      if (Number.isNaN(n) || n < 0) throw new Error(`--budget-usd invalid: ${v}`);
      budgetUsd = n;
    } else if (a === "--warmup-retries") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--warmup-retries requires a value");
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) throw new Error(`--warmup-retries invalid: ${v}`);
      warmupRetries = n;
    } else if (a === "--composer-entry") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--composer-entry requires a value");
      composerEntry = v;
    } else if (a === "--runs") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--runs requires a value");
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) throw new Error(`--runs invalid: ${v}`);
      runs = n;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { model, taskFilter, budgetUsd, warmupRetries, composerEntry, runs };
}

function resolveComposerEntry(repoRoot: string, override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`--composer-entry not found: ${override}`);
    return override;
  }
  if (fs.existsSync(INSTALLED_ENTRY)) return INSTALLED_ENTRY;
  const local = path.resolve(repoRoot, "dist/index.js");
  if (fs.existsSync(local)) return local;
  throw new Error(`no composer entry found; pass --composer-entry`);
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}
interface ResultEvent {
  type?: string;
  result?: string;
  is_error?: boolean;
  modelUsage?: Record<string, ModelUsageEntry>;
}

// Total CC tokens across ALL Claude models (orchestrator + subagents) — the
// real Max5/CC burn — plus the expensive output-only tier.
function ccFromModelUsage(mu: Record<string, ModelUsageEntry> | undefined): {
  ccTotal: number;
  ccOutput: number;
  perModel: Record<string, number>;
} {
  let ccTotal = 0;
  let ccOutput = 0;
  const perModel: Record<string, number> = {};
  for (const [model, u] of Object.entries(mu ?? {})) {
    const t =
      (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheCreationInputTokens ?? 0);
    ccTotal += t;
    ccOutput += u.outputTokens ?? 0;
    perModel[model] = t;
  }
  return { ccTotal, ccOutput, perModel };
}

function glmLogLineCount(): number {
  try {
    return fs.readFileSync(GLM_LOG, "utf8").trim().split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
// Sum input+output tokens of GLM rows appended since `sinceLine` (off-CC work).
function glmOffloadedSince(sinceLine: number): number {
  let lines: string[];
  try {
    lines = fs.readFileSync(GLM_LOG, "utf8").trim().split("\n").filter((l) => l.trim());
  } catch {
    return 0;
  }
  let sum = 0;
  for (const l of lines.slice(sinceLine)) {
    try {
      const o = JSON.parse(l) as { input_tokens?: number; output_tokens?: number };
      sum += (o.input_tokens ?? 0) + (o.output_tokens ?? 0);
    } catch {
      /* skip */
    }
  }
  return sum;
}

function parseStream(stdout: string): {
  blocks: ToolUseBlock[];
  final: ResultEvent | undefined;
  composerInitStatus: string;
} {
  const blocks: ToolUseBlock[] = [];
  let final: ResultEvent | undefined;
  let composerInitStatus = "absent";
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "system" && obj.subtype === "init") {
      const servers = Array.isArray(obj.mcp_servers) ? obj.mcp_servers : [];
      for (const s of servers as Array<Record<string, unknown>>) {
        if (s.name === "composer" && typeof s.status === "string") composerInitStatus = s.status;
      }
    } else if (obj.type === "assistant") {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? msg.content : [];
      for (const item of content as Array<Record<string, unknown>>) {
        if (item.type === "tool_use" && typeof item.name === "string") {
          blocks.push({ name: item.name, input: item.input as Record<string, unknown> | undefined });
        }
      }
    } else if (obj.type === "result") {
      final = obj as ResultEvent;
    }
  }
  return { blocks, final, composerInitStatus };
}

interface RunOutcome extends EvalResult {
  composerInitStatus: string;
  ccTotal: number;
  ccOutput: number;
  glmOffloaded: number;
  perModel: Record<string, number>;
}

async function runTask(
  task: EvalTask,
  model: string,
  budgetUsd: number,
  mcpConfigPath: string,
): Promise<RunOutcome> {
  const worktreePath = `/tmp/composer-measure-${process.pid}-${task.id}`;
  const start = Date.now();
  const glmBefore = glmLogLineCount();
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["worktree", "add", worktreePath, "HEAD", "--detach"], {}, (e) =>
        e ? reject(new Error(`git worktree add: ${e.message}`)) : resolve(),
      );
    });
    for (const rel of CLEAN_BEFORE[task.id] ?? []) {
      fs.rmSync(path.join(worktreePath, rel), { force: true });
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "claude",
        [
          "-p", "--output-format", "stream-json", "--verbose",
          "--permission-mode", "bypassPermissions",
          "--mcp-config", mcpConfigPath, "--strict-mcp-config",
          "--model", model, "--max-budget-usd", String(budgetUsd),
          task.prompt,
        ],
        { maxBuffer: 16 * 1024 * 1024, cwd: worktreePath, timeout: 600_000, killSignal: "SIGTERM" },
        (error, so, se) => {
          if (error) {
            const tail = (se ?? "").toString().trim().split("\n").slice(-3).join(" | ");
            reject(new Error(`${error.message}${tail ? ` [stderr: ${tail}]` : ""}`));
          } else resolve(so);
        },
      );
      child.stdin?.end();
    });

    const { blocks, final, composerInitStatus } = parseStream(stdout);
    const durationMs = Date.now() - start;
    const { ccTotal, ccOutput, perModel } = ccFromModelUsage(final?.modelUsage);
    const glmOffloaded = glmOffloadedSince(glmBefore);
    const actualSequence = extractToolUseDispatchSequence(blocks) as SubagentRole[];
    const success = checkSuccess(final?.result ?? "", task.expect.outputContains, final?.is_error ?? false);
    const dispatchedCorrectly = evaluateDispatch({
      actualSequence,
      expectedSequence: task.expect.dispatchSequence ?? [],
      dispatchRequired: task.expect.dispatchRequired,
      success,
    });

    return {
      taskId: task.id,
      success,
      mainSessionTokens: ccTotal, // score on TOTAL CC tokens
      dispatchedCorrectly,
      durationMs,
      workerCalls: actualSequence.length,
      workerTextSample: (final?.result ?? "").slice(0, 200),
      composerInitStatus,
      ccTotal,
      ccOutput,
      glmOffloaded,
      perModel,
    };
  } finally {
    await new Promise<void>((resolve) => {
      execFile("git", ["worktree", "remove", "--force", worktreePath], {}, () => resolve());
    });
  }
}

async function runWithWarmup(
  task: EvalTask,
  args: Args,
  baselineMainTokens: number,
  mcpConfigPath: string,
): Promise<{ outcome: RunOutcome; ts: TaskScore; attempts: number }> {
  const dispatchRequired = task.expect.dispatchRequired ?? true;
  let best: { outcome: RunOutcome; ts: TaskScore } | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt <= args.warmupRetries; attempt++) {
    attempts = attempt + 1;
    const outcome = await runTask(task, args.model, args.budgetUsd, mcpConfigPath);
    const ts = scoreTask(outcome, { baselineMainTokens });
    if (!best || ts.score > best.ts.score) best = { outcome, ts };
    const raceSuspected =
      dispatchRequired && !outcome.dispatchedCorrectly && outcome.composerInitStatus !== "connected";
    if (!raceSuspected) break;
    if (attempt < args.warmupRetries) {
      console.log(`  [${task.id}] retry ${attempt + 1}/${args.warmupRetries} — composer "${outcome.composerInitStatus}", no dispatch`);
    }
  }
  return { outcome: best!.outcome, ts: best!.ts, attempts };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const tasksPath = path.resolve(here, "../tasks.jsonl");
  const allTasks: EvalTask[] = fs
    .readFileSync(tasksPath, "utf8").trim().split("\n")
    .map((line) => EvalTaskSchema.parse(JSON.parse(line)));
  const tasks = args.taskFilter ? allTasks.filter((t) => t.id === args.taskFilter) : allTasks;
  if (tasks.length === 0) throw new Error(`no task matches --task ${args.taskFilter}`);

  const composerEntry = resolveComposerEntry(repoRoot, args.composerEntry);
  const mcpConfigPath = `/tmp/composer-measure-mcp-${process.pid}.json`;
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { composer: { command: "node", args: [composerEntry] } } }));

  console.log(`# Live measure (TOTAL-CC scope) — brainModel=${args.model}, cap=${args.budgetUsd}, warmupRetries=${args.warmupRetries}, runs=${args.runs}`);
  console.log(`# Composer MCP: node ${composerEntry} (direct, --strict-mcp-config)`);
  console.log(`# Score token-component on TOTAL CC tokens (all Claude models). GLM = off-CC offload, reported separately.`);
  console.log(`# Baselines: ${baselines.claudeModel ?? "?"} / CLI ${baselines.claudeCodeVersion ?? "?"}\n`);

  const logPath = "/tmp/composer-measure.jsonl";
  const rows: Array<Record<string, unknown>> = [];
  const scores: TaskScore[] = [];

  for (const task of tasks) {
    const baseline = baselines.baselines[task.id];
    if (!baseline) { console.error(`skip ${task.id}: no baseline`); continue; }
    try {
      const ccs: number[] = [];
      const scoreVals: number[] = [];
      let last: Awaited<ReturnType<typeof runWithWarmup>> | undefined;
      let successes = 0;
      let dispatchOks = 0;
      for (let run = 0; run < args.runs; run++) {
        const r = await runWithWarmup(task, args, baseline.mainSessionTokens, mcpConfigPath);
        last = r;
        ccs.push(r.outcome.ccTotal);
        scoreVals.push(r.ts.score);
        if (r.outcome.success) successes++;
        if (r.outcome.dispatchedCorrectly) dispatchOks++;
        console.log(`  [${task.id}] run ${run + 1}/${args.runs}: ccTotal=${r.outcome.ccTotal} score=${r.ts.score.toFixed(4)} success=${r.outcome.success} glmOff=${r.outcome.glmOffloaded}`);
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanCc = Math.round(mean(ccs));
      const meanScore = mean(scoreVals);
      scores.push({ taskId: task.id, score: meanScore, components: last!.ts.components });
      const savingsPct = ((1 - meanCc / baseline.mainSessionTokens) * 100).toFixed(1);
      const row = {
        taskId: task.id, brainModel: args.model, runs: args.runs,
        baselineCC: baseline.mainSessionTokens, ccTotalMean: meanCc,
        ccMin: Math.min(...ccs), ccMax: Math.max(...ccs),
        ccSavedPct: savingsPct, successRate: `${successes}/${args.runs}`,
        dispatchRate: `${dispatchOks}/${args.runs}`, scoreMean: meanScore.toFixed(4),
      };
      rows.push(row);
      fs.appendFileSync(logPath, JSON.stringify({ ...row, ccRuns: ccs }) + "\n");
    } catch (err) {
      console.error(`task ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      scores.push({ taskId: task.id, score: 0, components: { success: 0, token: 0, dispatch: 0 } });
      rows.push({ taskId: task.id, brainModel: args.model, runs: args.runs, baselineCC: baseline.mainSessionTokens, ccTotalMean: "ERR", ccMin: "-", ccMax: "-", ccSavedPct: "-", successRate: "-", dispatchRate: "-", scoreMean: "0.0000" });
    }
  }

  console.table(rows);
  console.log(`\naggregate: ${aggregateScore(scores).toFixed(4)}`);
  console.log(`per-task log appended: ${logPath}`);
}

main().catch((e: unknown) => {
  console.error("measure: fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
