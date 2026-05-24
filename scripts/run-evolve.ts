// Wave 3 Step 5 v1 — autoresearch driver.
// Wires real providers + synthetic v1 scorer into runEvolve(), writes
// the winner to SKILL.candidate.md for manual review/promotion.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runEvolve, type EvolveTask, type EvolveOptions, type EvolveDeps } from "../src/evolve/runner.js";
import { AnthropicCompatibleProvider } from "../src/providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "../src/providers/CLIProvider.js";
import { loadConfig } from "../src/config/loader.js";
import { type ComposerConfig } from "../src/config/schema.js";
import { applyEnvJson, getEnv } from "../src/config/env.js";
import { EvalTaskSchema } from "../tests/eval/schema.js";

export class SpendCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

export interface ParsedArgs {
  budgetUsd: number;
  maxRounds: number;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let budgetUsd = 2.0;
  let maxRounds = 10;

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
      i++;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  return { budgetUsd, maxRounds };
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

  const tasksPath = path.resolve(process.cwd(), "evals/tasks.jsonl");
  let tasks: EvolveTask[];
  try {
    const raw = fs.readFileSync(tasksPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    tasks = lines.map((line) => {
      const parsed = JSON.parse(line);
      const task = EvalTaskSchema.parse(parsed);
      return { id: task.id, description: task.prompt };
    });
  } catch (err) {
    console.error(`run-evolve: failed to read/parse tasks at ${tasksPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const evaluate = async (skill: string): Promise<{ score: number; transcripts: [] }> => {
    return { score: syntheticScore(skill), transcripts: [] };
  };

  // v1: no flakiness model — always confirm survival.
  const reReplicate = async (): Promise<boolean> => true;

  const deps: EvolveDeps = {
    reflectionProvider,
    researchProvider,
    evaluate,
    reReplicate,
    skillDomain: "composer-mastermind subagent orchestration",
  };

  const opts: EvolveOptions = {
    parent: skillText,
    tasks,
    deps,
    maxRounds: args.maxRounds,
    budget: { maxCalls: 100, maxUsd: args.budgetUsd },
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
