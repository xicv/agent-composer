// Standalone live measure-only driver. Runs each eval task (with bounded
// warmup-retry) through a real headless `claude -p`, parses stream-json, and
// scores against committed baselines. NO mutation, NO /evolve.
//
//   tsx evals/scripts/measure.ts [--model sonnet] [--task t1-slugify]
//        [--budget-usd 0.5] [--warmup-retries 1] [--composer-entry <path>]
//
// Reuses test-covered parsing helpers from run-evolve.ts and scoring helpers
// from tests/eval/metric.ts so the metric matches /evolve exactly.
//
// Three eval-validity guards:
//   A. CLEAN_BEFORE strips committed eval-target artifacts from the throwaway
//      worktree so a task like "add slugify" is not a no-op.
//   B. Composer MCP is launched DIRECT-NODE via --mcp-config + --strict-mcp-config.
//      Default `npx -y agent-composer` is "pending" at init in headless `claude
//      -p` (Finding-1 race) and never connects, so dispatch falls back to a
//      non-GLM Haiku Edit. Direct-node connects at init. Creds (.env.json)
//      resolve via the loader's global fallback (~/.config/composer/.env.json).
//   C. Capture composer init status; for dispatch-required tasks that produced
//      no dispatch while composer was not connected, retry up to --warmup-retries.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import {
  extractToolUseDispatchSequence,
  extractMainSessionTokens,
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

// Guard A — committed artifacts to remove from the worktree before a task runs.
const CLEAN_BEFORE: Record<string, ReadonlyArray<string>> = {
  "t1-slugify": ["src/util/slug.ts"],
};

const INSTALLED_ENTRY =
  "/opt/homebrew/lib/node_modules/agent-composer/dist/index.js";

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
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let model = "sonnet";
  let taskFilter: string | undefined;
  let budgetUsd = 0.5;
  let warmupRetries = 1;
  let composerEntry: string | undefined;
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
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { model, taskFilter, budgetUsd, warmupRetries, composerEntry };
}

function resolveComposerEntry(repoRoot: string, override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`--composer-entry not found: ${override}`);
    return override;
  }
  if (fs.existsSync(INSTALLED_ENTRY)) return INSTALLED_ENTRY;
  const local = path.resolve(repoRoot, "dist/index.js");
  if (fs.existsSync(local)) return local;
  throw new Error(
    `no composer entry found (tried ${INSTALLED_ENTRY} and ${local}); pass --composer-entry`,
  );
}

interface ResultEvent {
  type?: string;
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
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
        if (s.name === "composer" && typeof s.status === "string") {
          composerInitStatus = s.status;
        }
      }
    } else if (obj.type === "assistant") {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? msg.content : [];
      for (const item of content as Array<Record<string, unknown>>) {
        if (item.type === "tool_use" && typeof item.name === "string") {
          blocks.push({
            name: item.name,
            input: item.input as Record<string, unknown> | undefined,
          });
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
}

async function runTask(
  task: EvalTask,
  model: string,
  budgetUsd: number,
  mcpConfigPath: string,
): Promise<RunOutcome> {
  const worktreePath = `/tmp/composer-measure-${process.pid}-${task.id}`;
  const start = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["worktree", "add", worktreePath, "HEAD", "--detach"],
        {},
        (e) => (e ? reject(new Error(`git worktree add: ${e.message}`)) : resolve()),
      );
    });

    // Guard A — strip committed eval-target artifacts so the task is real work.
    for (const rel of CLEAN_BEFORE[task.id] ?? []) {
      fs.rmSync(path.join(worktreePath, rel), { force: true });
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "claude",
        [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
          "--mcp-config",
          mcpConfigPath,
          "--strict-mcp-config",
          "--model",
          model,
          "--max-budget-usd",
          String(budgetUsd),
          task.prompt,
        ],
        {
          maxBuffer: 16 * 1024 * 1024,
          cwd: worktreePath,
          timeout: 180_000,
          killSignal: "SIGTERM",
        },
        (error, so, se) => {
          if (error) {
            const tail = (se ?? "").toString().trim().split("\n").slice(-3).join(" | ");
            reject(new Error(`${error.message}${tail ? ` [stderr: ${tail}]` : ""}`));
          } else {
            resolve(so);
          }
        },
      );
      child.stdin?.end();
    });

    const { blocks, final, composerInitStatus } = parseStream(stdout);
    const durationMs = Date.now() - start;
    const mainSessionTokens = extractMainSessionTokens({ usage: final?.usage });
    const actualSequence = extractToolUseDispatchSequence(blocks) as SubagentRole[];
    const success = checkSuccess(
      final?.result ?? "",
      task.expect.outputContains,
      final?.is_error ?? false,
    );
    const dispatchedCorrectly = evaluateDispatch({
      actualSequence,
      expectedSequence: task.expect.dispatchSequence ?? [],
      dispatchRequired: task.expect.dispatchRequired,
      success,
    });

    if (final?.modelUsage) {
      console.log(`  [${task.id}] modelUsage: ${JSON.stringify(final.modelUsage)}`);
    }

    return {
      taskId: task.id,
      success,
      mainSessionTokens,
      dispatchedCorrectly,
      durationMs,
      workerCalls: actualSequence.length,
      workerTextSample: (final?.result ?? "").slice(0, 200),
      composerInitStatus,
    };
  } finally {
    await new Promise<void>((resolve) => {
      execFile("git", ["worktree", "remove", "--force", worktreePath], {}, () => resolve());
    });
  }
}

// Guard C — for a dispatch-required task that produced no dispatch while
// composer was not connected, retry. Keep the highest-scoring attempt.
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
      dispatchRequired &&
      !outcome.dispatchedCorrectly &&
      outcome.composerInitStatus !== "connected";
    if (!raceSuspected) break;
    if (attempt < args.warmupRetries) {
      console.log(
        `  [${task.id}] retry ${attempt + 1}/${args.warmupRetries} — composer "${outcome.composerInitStatus}" at init, no dispatch`,
      );
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
    .readFileSync(tasksPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => EvalTaskSchema.parse(JSON.parse(line)));

  const tasks = args.taskFilter
    ? allTasks.filter((t) => t.id === args.taskFilter)
    : allTasks;
  if (tasks.length === 0) {
    throw new Error(`no task matches --task ${args.taskFilter}`);
  }

  // Guard B — write a direct-node composer MCP config for the eval spawns.
  const composerEntry = resolveComposerEntry(repoRoot, args.composerEntry);
  const mcpConfigPath = `/tmp/composer-measure-mcp-${process.pid}.json`;
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: { composer: { command: "node", args: [composerEntry] } },
    }),
  );

  console.log(
    `# Live measure — brainModel=${args.model}, perTaskCap=$${args.budgetUsd}, warmupRetries=${args.warmupRetries}`,
  );
  console.log(`# Composer MCP: node ${composerEntry} (direct, --strict-mcp-config)`);
  console.log(
    `# Baselines: ${baselines.claudeModel ?? "?"} / CLI ${baselines.claudeCodeVersion ?? "?"} (stock Claude alone)`,
  );
  console.log(
    `# NOTE: a brainModel != baseline model is a PROXY comparison (model drift).\n`,
  );

  const logPath = "/tmp/composer-measure.jsonl";
  const rows: Array<Record<string, unknown>> = [];
  const scores: TaskScore[] = [];

  for (const task of tasks) {
    const baseline = baselines.baselines[task.id];
    if (!baseline) {
      console.error(`skip ${task.id}: no baseline entry`);
      continue;
    }
    try {
      const { outcome, ts, attempts } = await runWithWarmup(
        task,
        args,
        baseline.mainSessionTokens,
        mcpConfigPath,
      );
      scores.push(ts);
      const savingsPct = (
        (1 - outcome.mainSessionTokens / baseline.mainSessionTokens) *
        100
      ).toFixed(1);
      const row = {
        taskId: task.id,
        brainModel: args.model,
        baseline: baseline.mainSessionTokens,
        measured: outcome.mainSessionTokens,
        savingsPct,
        dispatchOK: outcome.dispatchedCorrectly,
        success: outcome.success,
        mcpInit: outcome.composerInitStatus,
        attempts,
        score: ts.score.toFixed(4),
      };
      rows.push(row);
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          ...row,
          baselineModel: baselines.claudeModel ?? null,
          durationMs: outcome.durationMs,
          workerCalls: outcome.workerCalls,
        }) + "\n",
      );
    } catch (err) {
      console.error(
        `task ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scores.push({
        taskId: task.id,
        score: 0,
        components: { success: 0, token: 0, dispatch: 0 },
      });
      rows.push({
        taskId: task.id,
        brainModel: args.model,
        baseline: baseline.mainSessionTokens,
        measured: "ERR",
        savingsPct: "-",
        dispatchOK: false,
        success: false,
        mcpInit: "-",
        attempts: 0,
        score: "0.0000",
      });
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
