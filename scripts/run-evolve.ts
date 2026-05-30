// Wave 3 Step 5 v2 — autoresearch driver with real-mode evaluator.
// Wires real providers + synthetic v1 scorer into runEvolve(), writes
// the winner to SKILL.candidate.md for manual review/promotion.
// Real mode spawns claude CLI per-task inside a throwaway git worktree (cwd-isolated).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { runEvolve, type EvolveOptions, type EvolveDeps } from "../src/evolve/runner.js";
import { OPERATOR_BY_CLI_NAME, VALID_OPERATOR_CLI_NAMES } from "../src/evolve/operators.js";
import { AnthropicCompatibleProvider } from "../src/providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "../src/providers/CLIProvider.js";
import { loadConfig } from "../src/config/loader.js";
import { type ComposerConfig } from "../src/config/schema.js";
import { applyEnvJson, getEnv } from "../src/config/env.js";
import { EvalTaskSchema, type EvalTaskExpect } from "../tests/eval/schema.js";

interface ExtendedEvolveTask {
  id: string;
  description: string;
  expect?: EvalTaskExpect;
}

export class SpendCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

export interface ParsedArgs {
  budgetUsd: number;
  maxRounds: number;
  evalMode: "synthetic" | "real";
  lengthLambda?: number;
  forceOperator?: string;
  replicas: number;
  tasksPath?: string;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let budgetUsd = 2.0;
  let maxRounds = 10;
  let evalMode: "synthetic" | "real" = "synthetic";
  let maxRoundsExplicit = false;
  let lengthLambda: number | undefined;
  let forceOperator: string | undefined;
  let replicas = 1;
  let tasksPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--budget-usd") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--budget-usd requires a value");
      const num = parseFloat(val);
      if (isNaN(num)) throw new Error(`--budget-usd: "${val}" is not a number`);
      if (num < 0) throw new Error("--budget-usd must be non-negative");
      budgetUsd = num;
      i++;
    } else if (arg === "--max-rounds") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--max-rounds requires a value");
      const num = parseInt(val, 10);
      if (isNaN(num)) throw new Error(`--max-rounds: "${val}" is not a number`);
      if (num < 0) throw new Error("--max-rounds must be non-negative");
      maxRounds = num;
      maxRoundsExplicit = true;
      i++;
    } else if (arg === "--eval-mode") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--eval-mode requires a value");
      if (val !== "synthetic" && val !== "real") {
        throw new Error(`--eval-mode: "${val}" must be "synthetic" or "real"`);
      }
      evalMode = val;
      i++;
    } else if (arg === "--length-lambda") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--length-lambda requires a value");
      const num = parseFloat(val);
      if (isNaN(num)) throw new Error(`--length-lambda: "${val}" is not a number`);
      if (num < 0) throw new Error("--length-lambda must be non-negative");
      lengthLambda = num;
      i++;
    } else if (arg === "--force-operator") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--force-operator requires a value");
      if (!(val in OPERATOR_BY_CLI_NAME)) {
        throw new Error(
          `--force-operator: "${val}" is unknown; valid names: ${VALID_OPERATOR_CLI_NAMES.join(", ")}`,
        );
      }
      forceOperator = val;
      i++;
    } else if (arg === "--replicas") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--replicas requires a value");
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1) throw new Error(`--replicas: "${val}" must be a positive integer`);
      replicas = num;
      i++;
    } else if (arg === "--tasks") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--tasks requires a value");
      tasksPath = val;
      i++;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  // Real mode defaults to 3 rounds unless user overrides
  if (evalMode === "real" && !maxRoundsExplicit) {
    maxRounds = 3;
  }

  return { budgetUsd, maxRounds, evalMode, lengthLambda, forceOperator, replicas, tasksPath };
}

export function enforceSpendCap(config: ComposerConfig, budgetUsd: number): void {
  const auth = config.spendAuthorization;
  if (!auth || !auth.maxUsdPerSession) return;
  if (budgetUsd > auth.maxUsdPerSession) {
    throw new SpendCapExceededError(
      `--budget-usd ${budgetUsd.toFixed(2)} exceeds composer.config.json spendAuthorization.maxUsdPerSession ${auth.maxUsdPerSession.toFixed(2)}`,
    );
  }
}

export function syntheticScore(skill: string): number {
  let score = 0;

  if (skill.toLowerCase().includes("dispatch")) {
    score += 0.4;
  }

  if (skill.includes("Read")) {
    score += 0.2;
  }

  const charCount = skill.length;
  let lengthScore = 0;
  if (charCount >= 2000 && charCount <= 6000) {
    lengthScore = 1 - Math.abs(charCount - 4000) / 2000;
  }
  score += 0.4 * lengthScore;

  return Math.min(1, Math.max(0, score));
}

interface ClaudeJsonResponse {
  // Old format (for test fixtures)
  content?: Array<{
    type: string;
    text?: string;
  }>;
  // New stream-json format
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: Array<Record<string, unknown>> };
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

// TOTAL CC tokens across ALL Claude models (orchestrator + subagents) = real
// Max5 burn — the correct scope (orchestrator-only hides the subagent savings).
function ccTotalFromModelUsage(
  mu: ClaudeJsonResponse["modelUsage"],
): number {
  if (!mu) return 0;
  let total = 0;
  for (const u of Object.values(mu)) {
    total +=
      (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheCreationInputTokens ?? 0);
  }
  return total;
}

function extractMainSessionTokens(response: ClaudeJsonResponse): number {
  const u = response.usage;
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  );
}

interface ToolUseBlock {
  name: string;
  input?: Record<string, unknown>;
}

function extractToolUseDispatchSequence(
  toolUseBlocks: ToolUseBlock[],
): string[] {
  const roles: string[] = [];

  for (const block of toolUseBlocks) {
    if (block.name === "Task") {
      const subType =
        (block.input?.subagent_type as string) ??
        (block.input?.description as string) ??
        "";
      if (/coder/i.test(subType)) {
        roles.push("coder");
      } else if (/reviewer/i.test(subType)) {
        roles.push("reviewer");
      } else if (/researcher/i.test(subType)) {
        roles.push("researcher");
      }
    } else if (block.name.startsWith("mcp__composer__composer_")) {
      const suffix = block.name.slice("mcp__composer__composer_".length);
      if (suffix === "code") {
        roles.push("coder");
      } else if (suffix === "review") {
        roles.push("reviewer");
      } else if (suffix === "research") {
        roles.push("researcher");
      }
    }
    // ignore all other tool names
  }

  return roles;
}

function checkSuccess(
  resultText: string,
  outputContains: readonly string[] | undefined,
  isError: boolean,
): boolean {
  if (isError) return false;
  if (!outputContains || outputContains.length === 0) {
    return true;
  }

  const lowerText = resultText.toLowerCase();
  return outputContains.every((substr) => lowerText.includes(substr.toLowerCase()));
}

function loadBaselines(): Record<string, { mainSessionTokens: number }> {
  const baselinePath = path.resolve(process.cwd(), "evals/baselines.json");
  try {
    const raw = fs.readFileSync(baselinePath, "utf8");
    const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const baselines: Record<string, { mainSessionTokens: number }> = {};

    if (data.baselines && typeof data.baselines === "object") {
      for (const [key, val] of Object.entries(data.baselines)) {
        if (val && typeof val === "object" && typeof (val as Record<string, unknown>).mainSessionTokens === "number") {
          baselines[key] = { mainSessionTokens: (val as Record<string, unknown>).mainSessionTokens as number };
        }
      }
    }

    return baselines;
  } catch {
    return {};
  }
}

interface EvalResult {
  taskId: string;
  success: boolean;
  mainSessionTokens: number;
  dispatchedCorrectly: boolean;
  durationMs: number;
  workerCalls: number;
  workerTextSample: string;
}

function evaluateDispatch(input: {
  actualSequence: string[];
  expectedSequence: string[];
  dispatchRequired: boolean;
  success: boolean;
}): boolean {
  const { actualSequence, expectedSequence, success } = input;
  const required = input.dispatchRequired;
  const actualMatchesExpected =
    actualSequence.length === expectedSequence.length &&
    actualSequence.every((r, i) => r === expectedSequence[i]);

  if (required) return actualMatchesExpected;

  // Lenient: no dispatch is OK iff inline answer succeeded.
  if (actualSequence.length === 0) return success;

  // Dispatch happened anyway — must still match the expected sequence.
  return actualMatchesExpected;
}

interface TaskScore {
  taskId: string;
  score: number;
}

function scoreTask(result: EvalResult, baseline: number): TaskScore {
  const baselineTokens = baseline > 0 ? baseline : 1;
  const tokenComponent =
    baseline > 0 ? Math.max(0, 1 - result.mainSessionTokens / baselineTokens) : 0;

  const successComponent = result.success ? 1 : 0;
  const dispatchComponent = result.dispatchedCorrectly ? 1 : 0;

  // Weights: 0.5 success + 0.3 token + 0.2 dispatch
  const score = 0.5 * successComponent + 0.3 * tokenComponent + 0.2 * dispatchComponent;

  return {
    taskId: result.taskId,
    score,
  };
}

function aggregateScore(scores: TaskScore[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((acc, s) => acc + s.score, 0) / scores.length;
}

// Export types and helper functions for testing
export type { ToolUseBlock };
export { extractToolUseDispatchSequence, extractMainSessionTokens, checkSuccess };

export function createRealEvaluate(_skillPath: string, baselines: Record<string, { mainSessionTokens: number }>, replicas = 1) {
  return async (skill: string, tasks: ReadonlyArray<ExtendedEvolveTask>): Promise<{ score: number; transcripts: [] }> => {
    const results: TaskScore[] = [];
    // Eval orchestrator must use the real Claude endpoint (Max5), NOT the z.ai
    // base URL applyEnvJson set for the GLM reflection provider. Strip it so
    // `claude -p --model sonnet` does not 400 on the GLM endpoint. The composer
    // MCP the child spawns still reads its own .env.json for GLM creds.
    const evalEnv: NodeJS.ProcessEnv = { ...process.env };
    delete evalEnv.ANTHROPIC_BASE_URL;
    delete evalEnv.ANTHROPIC_AUTH_TOKEN;
    delete evalEnv.ANTHROPIC_MODEL;

    for (const task of tasks) {
      const replicaScores: number[] = [];
      for (let replica = 0; replica < replicas; replica++) {
      const worktreePath = `/tmp/composer-eval-${process.pid}-${task.id}-r${replica}`;
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("git", ["worktree", "add", worktreePath, "HEAD", "--detach"], {}, (error) => {
            if (error) reject(new Error(`git worktree add failed: ${error instanceof Error ? error.message : String(error)}`));
            else resolve();
          });
        });

        // Write candidate SKILL into worktree only — real repo SKILL.md is never touched
        const worktreeSkillPath = path.join(worktreePath, ".claude/skills/composer-mastermind/SKILL.md");
        fs.writeFileSync(worktreeSkillPath, skill, "utf8");

        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            "claude",
            [
              "-p",
              "--output-format",
              "stream-json",
              "--verbose",
              "--permission-mode",
              "bypassPermissions",
              "--model",
              "sonnet",
              "--max-budget-usd",
              "0.50",
              task.description,
            ],
            { maxBuffer: 16 * 1024 * 1024, cwd: worktreePath, timeout: 180_000, killSignal: "SIGTERM", env: evalEnv },
            (error, stdout, stderr) => {
              if (error) {
                const stderrTail = (stderr ?? "").toString().trim().split("\n").slice(-3).join(" | ");
                const stdoutTail = (stdout ?? "").toString().trim().split("\n").slice(-2).join(" | ");
                const errAny = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
                const timedOut = errAny.killed === true || errAny.signal === "SIGTERM";
                const timeoutMarker = timedOut ? " [TIMEOUT after 180s]" : "";
                const diag = stderrTail || stdoutTail
                  ? ` [stderr: ${stderrTail}] [stdout: ${stdoutTail}]`
                  : "";
                reject(new Error(`${error.message}${timeoutMarker}${diag}`));
              } else {
                resolve(stdout);
              }
            },
          );
          child.stdin?.end();
        });

        // Parse NDJSON output: split, filter empty lines, JSON.parse each line
        const lines = output.split("\n").filter((line) => line.trim().length > 0);
        const parsedEvents: ClaudeJsonResponse[] = [];

        for (const line of lines) {
          try {
            parsedEvents.push(JSON.parse(line) as ClaudeJsonResponse);
          } catch {
            // skip unparseable lines
          }
        }

        // Collect all tool_use blocks from assistant message lines
        const toolUseBlocks: ToolUseBlock[] = [];
        for (const event of parsedEvents) {
          // stream-json: assistant events carry message.content[]; old fixtures used content[]
          const contentArray = event.message?.content ?? event.content ?? [];
          for (const item of contentArray as Array<Record<string, unknown>>) {
            if (item.type === "tool_use" && typeof item.name === "string") {
              toolUseBlocks.push({
                name: item.name,
                input: item.input as Record<string, unknown> | undefined,
              });
            }
          }
        }

        // Find final result event
        const resultEvent = parsedEvents.find((e) => e.type === "result");

        const mainSessionTokens = resultEvent?.modelUsage
          ? ccTotalFromModelUsage(resultEvent.modelUsage)
          : extractMainSessionTokens(resultEvent ?? {});
        const actualSequence = extractToolUseDispatchSequence(toolUseBlocks);
        const resultText = resultEvent?.result ?? "";
        const isError = resultEvent?.is_error === true;
        const outputOk = checkSuccess(resultText, task.expect?.outputContains, isError);

        // #4 correctness gate: run tsc on the generated code (off-CC, in worktree).
        // node_modules is gitignored -> symlink the repo's so tsc can resolve.
        let correctnessOk = true;
        try {
          fs.symlinkSync(
            path.join(process.cwd(), "node_modules"),
            path.join(worktreePath, "node_modules"),
          );
        } catch {
          /* already linked or unavailable */
        }
        await new Promise<void>((resolveTsc) => {
          execFile(
            path.join(worktreePath, "node_modules/.bin/tsc"),
            ["--noEmit"],
            { cwd: worktreePath, timeout: 120_000 },
            (tscErr) => {
              if (tscErr) {
                const code = (tscErr as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                  // tsc unavailable — cannot check, do not penalise
                } else {
                  correctnessOk = false; // tsc ran and found type errors
                }
              }
              resolveTsc();
            },
          );
        });
        const success = outputOk && correctnessOk;

        const expectedSequence = task.expect?.dispatchSequence ?? [];
        const dispatchRequired = task.expect?.dispatchRequired ?? true;

        const dispatchedCorrectly = evaluateDispatch({
          actualSequence,
          expectedSequence,
          dispatchRequired,
          success,
        });

        const evalResult: EvalResult = {
          taskId: task.id,
          success,
          mainSessionTokens,
          dispatchedCorrectly,
          durationMs: 0,
          workerCalls: 1,
          workerTextSample: "",
        };

        const baseline = baselines[task.id]?.mainSessionTokens ?? 0;
        const taskScore = scoreTask(evalResult, baseline);
        replicaScores.push(taskScore.score);
      } catch (err) {
        console.error(`run-evolve: task ${task.id} failed (replica ${replica}): ${err instanceof Error ? err.message : String(err)}`);
        replicaScores.push(0);
      } finally {
        await new Promise<void>((resolve) => {
          execFile("git", ["worktree", "remove", "--force", worktreePath], {}, () => resolve());
        });
      }
      }
      // N-replica averaging: mean per-task score reduces single-run variance.
      const meanScore = replicaScores.reduce((a, b) => a + b, 0) / Math.max(1, replicaScores.length);
      results.push({ taskId: task.id, score: meanScore });
    }

    return { score: aggregateScore(results), transcripts: [] };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let config: ComposerConfig;
  try {
    config = loadConfig("composer.config.json");
  } catch (err) {
    console.error("run-evolve: failed to load composer.config.json:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  try {
    enforceSpendCap(config, args.budgetUsd);
  } catch (err) {
    if (err instanceof SpendCapExceededError) {
      console.error(`run-evolve: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  applyEnvJson();
  const env = getEnv();

  if (!env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL) {
    console.error("run-evolve: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL not configured in .env.json or environment");
    process.exit(1);
  }

  const codeModel = env.ANTHROPIC_MODEL ?? config.roles.coder.model ?? "glm-5.1";
  const reflectionProvider = new AnthropicCompatibleProvider({
    baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: env.ANTHROPIC_AUTH_TOKEN,
    model: codeModel,
  });

  const researcherCliConfig = config.roles.researcher.cli;
  if (!researcherCliConfig) {
    console.error("run-evolve: composer.config.json roles.researcher.cli not configured");
    process.exit(1);
  }

  const researchProvider = new CLIProvider({
    cli: researcherCliConfig,
  });

  const skillPath = path.resolve(process.cwd(), ".claude/skills/composer-mastermind/SKILL.md");
  let skillText: string;
  try {
    skillText = fs.readFileSync(skillPath, "utf8");
  } catch (err) {
    console.error(`run-evolve: failed to read skill at ${skillPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const tasksPath = args.tasksPath ? path.resolve(args.tasksPath) : path.resolve(process.cwd(), "evals/tasks.jsonl");
  let tasks: ExtendedEvolveTask[];
  try {
    const raw = fs.readFileSync(tasksPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    tasks = lines.map((line) => {
      const parsed = JSON.parse(line);
      const task = EvalTaskSchema.parse(parsed);
      return { id: task.id, description: task.prompt, expect: task.expect };
    });
  } catch (err) {
    console.error(`run-evolve: failed to read/parse tasks at ${tasksPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Real mode budget pre-check
  if (args.evalMode === "real") {
    const evalCostPerTask = 3 * 0.5; // 3 evaluations × $0.50 each
    const totalEvalCost = tasks.length * args.maxRounds * evalCostPerTask;
    if (totalEvalCost > args.budgetUsd) {
      console.error(
        `run-evolve: real-eval budget check: ${tasks.length} tasks × ${args.maxRounds} rounds × 3 evals × $0.50 = $${totalEvalCost.toFixed(2)}; budget $${args.budgetUsd.toFixed(2)} insufficient`,
      );
      process.exit(1);
    }
  }

  // Choose evaluate function based on mode
  const baselines = loadBaselines();
  const evaluate =
    args.evalMode === "real"
      ? createRealEvaluate(skillPath, baselines, args.replicas)
      : async (skill: string) => ({ score: syntheticScore(skill), transcripts: [] });

  // v1: no flakiness model — always confirm survival.
  const reReplicate = async (): Promise<boolean> => true;

  const deps: EvolveDeps = {
    reflectionProvider,
    researchProvider,
    evaluate,
    reReplicate,
    skillDomain: "composer-mastermind subagent orchestration",
    ...(args.forceOperator !== undefined
      ? { pickOperator: () => OPERATOR_BY_CLI_NAME[args.forceOperator!]! }
      : {}),
  };

  const opts: EvolveOptions = {
    parent: skillText,
    tasks,
    deps,
    maxRounds: args.maxRounds,
    budget: { maxCalls: 100, maxUsd: args.budgetUsd },
    ...(args.lengthLambda !== undefined ? { lengthLambda: args.lengthLambda } : {}),
  };

  const result = await runEvolve(opts);

  if (result.winner !== skillText) {
    const candidatePath = path.resolve(process.cwd(), ".claude/skills/composer-mastermind/SKILL.candidate.md");
    try {
      fs.writeFileSync(candidatePath, result.winner, "utf8");
    } catch (err) {
      console.error(`run-evolve: failed to write candidate at ${candidatePath}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else {
    console.log("no improvement detected; SKILL.candidate.md not written");
  }

  console.log("--- /evolve summary ---");

  if (result.history.length > 0) {
    console.log("| round | operator | parentScore | candidateScore | promoted | reason |");
    console.log("|-------|----------|-------------|----------------|----------|--------|");
    for (const log of result.history) {
      const parentStr = log.parentScore.toFixed(4);
      const candStr = log.candidateScore.toFixed(4);
      const promStr = log.promoted ? "yes" : "no";
      const reasonShort = log.reason.substring(0, 40);
      console.log(`| ${log.round} | ${log.operator} | ${parentStr} | ${candStr} | ${promStr} | ${reasonShort} |`);
    }
  }

  if (args.lengthLambda !== undefined) {
    console.log(`lengthLambda: ${args.lengthLambda}`);
  }
  if (args.forceOperator !== undefined) {
    console.log(`forcedOperator: ${args.forceOperator}`);
  }
  console.log(`stoppedAt: ${result.stoppedAt}`);
  console.log(
    `postflight: accept=${result.postflight?.accept ?? "n/a"} reason="${result.postflight?.reason ?? ""}"`,
  );
  console.log(`budgetStats: calls=${result.budgetStats.calls} usd=$${result.budgetStats.usd.toFixed(4)}`);

  const parentScore = syntheticScore(skillText);
  const winnerScore = syntheticScore(result.winner);
  console.log(`parent score: ${parentScore.toFixed(4)} → winner score: ${winnerScore.toFixed(4)}`);
}

const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  main().catch((err: unknown) => {
    console.error("run-evolve: fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
