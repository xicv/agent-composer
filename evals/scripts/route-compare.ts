// Live route comparison harness.
//
// Runs the same eval tasks through:
//   - cc-only                 stock Claude, no composer MCP
//   - composer-codex-cli      Composer MCP, force composer_code_cli
//
// Writes JSONL records that can be re-summarized without spending more tokens:
//   tsx evals/scripts/route-compare.ts --task t8-csv-module --runs 3
//   tsx evals/scripts/route-compare.ts --summary-only --input /tmp/composer-route-runs.jsonl

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RouteNameSchema,
  formatRouteSummary,
  parseRouteRunJsonl,
  summarizeRouteRuns,
  type RouteName,
  type RouteRunRecord,
} from "../../tests/eval/route-metrics.js";
import { EvalTaskSchema, type EvalTask } from "../../tests/eval/schema.js";

const DEFAULT_ROUTES: RouteName[] = [
  "cc-only",
  "composer-codex-cli",
];
const DEFAULT_OUT = "/tmp/composer-route-runs.jsonl";
const DEFAULT_MODEL = "sonnet";
const DEFAULT_BUDGET_USD = 0.5;
const DEFAULT_TIMEOUT_MS = 600_000;
const INSTALLED_ENTRY = "/opt/homebrew/lib/node_modules/agent-composer/dist/index.js";
const CLEAN_BEFORE: Record<string, ReadonlyArray<string>> = {
  "t1-slugify": ["src/util/slug.ts"],
};

interface Args {
  routes: RouteName[];
  taskFilter?: string;
  runs: number;
  model: string;
  budgetUsd: number;
  composerEntry?: string;
  inputPath: string;
  outPath: string;
  summaryOnly: boolean;
  skipTypecheck: boolean;
  timeoutMs: number;
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ClaudeResultEvent {
  type?: string;
  result?: string;
  is_error?: boolean;
  modelUsage?: Record<string, ModelUsageEntry>;
}

interface ToolUseBlock {
  name: string;
  input?: Record<string, unknown>;
}

interface ParsedStream {
  final?: ClaudeResultEvent;
  toolUses: ToolUseBlock[];
}

export function parseArgs(argv: ReadonlyArray<string>): Args {
  let routes = DEFAULT_ROUTES;
  let taskFilter: string | undefined;
  let runs = 1;
  let model = DEFAULT_MODEL;
  let budgetUsd = DEFAULT_BUDGET_USD;
  let composerEntry: string | undefined;
  let inputPath = DEFAULT_OUT;
  let outPath = DEFAULT_OUT;
  let summaryOnly = false;
  let skipTypecheck = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--routes") {
      const value = requireValue(argv, ++i, "--routes");
      routes = value.split(",").map((route) => RouteNameSchema.parse(route.trim()));
    } else if (arg === "--task") {
      taskFilter = requireValue(argv, ++i, "--task");
    } else if (arg === "--runs") {
      runs = parsePositiveInt(requireValue(argv, ++i, "--runs"), "--runs");
    } else if (arg === "--model") {
      model = requireValue(argv, ++i, "--model");
    } else if (arg === "--budget-usd") {
      budgetUsd = parseNonNegativeNumber(requireValue(argv, ++i, "--budget-usd"), "--budget-usd");
    } else if (arg === "--composer-entry") {
      composerEntry = requireValue(argv, ++i, "--composer-entry");
    } else if (arg === "--input") {
      inputPath = requireValue(argv, ++i, "--input");
    } else if (arg === "--out") {
      outPath = requireValue(argv, ++i, "--out");
    } else if (arg === "--summary-only") {
      summaryOnly = true;
    } else if (arg === "--skip-typecheck") {
      skipTypecheck = true;
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(requireValue(argv, ++i, "--timeout-ms"), "--timeout-ms");
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (routes.length === 0) throw new Error("--routes must contain at least one route");
  return {
    routes,
    taskFilter,
    runs,
    model,
    budgetUsd,
    composerEntry,
    inputPath,
    outPath,
    summaryOnly,
    skipTypecheck,
    timeoutMs,
  };
}

export function routePrompt(route: RouteName, task: EvalTask): string {
  if (route === "cc-only") {
    return [
      "ROUTE UNDER TEST: cc-only.",
      "Do the task directly in this Claude Code run. Do not use Composer MCP tools.",
      "Keep the final answer short and include the task keyword from the acceptance criteria.",
      "",
      task.prompt,
    ].join("\n");
  }

  return [
    "ROUTE UNDER TEST: composer-codex-cli.",
    "Use Composer for implementation. For file create/edit/refactor work, call composer_handoff_create when useful, then use mcp__composer__composer_code_cli.",
    "After code is applied, review or summarize the changed diff and keep the final answer short.",
    "",
    task.prompt,
  ].join("\n");
}

export function parseClaudeStream(stdout: string): ParsedStream {
  const toolUses: ToolUseBlock[] = [];
  let final: ClaudeResultEvent | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const item of content as Array<Record<string, unknown>>) {
        if (item.type === "tool_use" && typeof item.name === "string") {
          toolUses.push({
            name: item.name,
            input: item.input as Record<string, unknown> | undefined,
          });
        }
      }
    } else if (event.type === "result") {
      final = event as ClaudeResultEvent;
    }
  }

  return { final, toolUses };
}

export function ccTokensFromModelUsage(
  usage: Record<string, ModelUsageEntry> | undefined,
): number {
  let total = 0;
  for (const item of Object.values(usage ?? {})) {
    total +=
      (item.inputTokens ?? 0) +
      (item.outputTokens ?? 0) +
      (item.cacheReadInputTokens ?? 0) +
      (item.cacheCreationInputTokens ?? 0);
  }
  return total;
}

export function observedRoute(toolUses: ReadonlyArray<ToolUseBlock>): string {
  if (toolUses.some((tool) => tool.name.includes("composer_code_cli"))) {
    return "composer-codex-cli";
  }
  if (toolUses.some((tool) => tool.name.startsWith("mcp__composer__"))) {
    return "composer-other";
  }
  return "cc-only";
}

export function routeHonored(
  requested: RouteName,
  observed: string,
  toolUses: ReadonlyArray<ToolUseBlock>,
): boolean {
  if (requested === "cc-only") {
    return !toolUses.some((tool) => tool.name.startsWith("mcp__composer__"));
  }
  return observed === requested;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.summaryOnly) {
    const rows = parseRouteRunJsonl(fs.readFileSync(args.inputPath, "utf8"));
    const summary = summarizeRouteRuns(rows);
    process.stdout.write(formatRouteSummary(summary) + "\n");
    return;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const tasks = loadTasks(path.resolve(here, "../tasks.jsonl"), args.taskFilter);
  const composerEntry = resolveComposerEntry(repoRoot, args.composerEntry);
  const baselines = loadBaselines(path.resolve(here, "../baselines.json"));

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  process.stdout.write(
    `# route compare: routes=${args.routes.join(",")} tasks=${tasks.length} runs=${args.runs} model=${args.model}\n`,
  );
  process.stdout.write(`# jsonl: ${args.outPath}\n`);

  const emitted: RouteRunRecord[] = [];
  for (const task of tasks) {
    for (const route of args.routes) {
      for (let run = 1; run <= args.runs; run++) {
        const row = await runRoute({
          repoRoot,
          composerEntry,
          task,
          route,
          run,
          model: args.model,
          budgetUsd: args.budgetUsd,
          timeoutMs: args.timeoutMs,
          skipTypecheck: args.skipTypecheck,
          baselineCcTokens: baselines.get(task.id),
        });
        emitted.push(row);
        fs.appendFileSync(args.outPath, JSON.stringify(row) + "\n");
        process.stdout.write(
          `[${task.id}] ${route} run ${run}/${args.runs}: success=${row.success} honored=${row.routeHonored} cc=${row.ccTokens}` +
            (row.error ? ` error=${row.error.slice(0, 100)}` : "") +
            "\n",
        );
      }
    }
  }

  process.stdout.write("\n" + formatRouteSummary(summarizeRouteRuns(emitted)) + "\n");
}

interface RunRouteInput {
  repoRoot: string;
  composerEntry: string;
  task: EvalTask;
  route: RouteName;
  run: number;
  model: string;
  budgetUsd: number;
  timeoutMs: number;
  skipTypecheck: boolean;
  baselineCcTokens?: number;
}

async function runRoute(input: RunRouteInput): Promise<RouteRunRecord> {
  const worktree = `/tmp/composer-route-${process.pid}-${input.task.id}-${input.route}-${input.run}`;
  const started = Date.now();
  try {
    await execFilePromise("git", ["worktree", "add", worktree, "HEAD", "--detach"], {
      cwd: input.repoRoot,
      timeout: 120_000,
    });
    for (const rel of CLEAN_BEFORE[input.task.id] ?? []) {
      fs.rmSync(path.join(worktree, rel), { force: true });
    }
    if (input.route === "cc-only") {
      fs.rmSync(path.join(worktree, ".claude"), { recursive: true, force: true });
    }

    const mcpConfig = writeMcpConfig(input.route, worktree, input.composerEntry);
    const prompt = routePrompt(input.route, input.task);
    const claudeArgs = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--model",
      input.model,
      "--max-budget-usd",
      String(input.budgetUsd),
      prompt,
    ];

    const { stdout } = await execFilePromise("claude", claudeArgs, {
      cwd: worktree,
      timeout: input.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = parseClaudeStream(stdout);
    const observed = observedRoute(parsed.toolUses);
    const typecheckPassed = input.skipTypecheck ? undefined : await runTypecheck(worktree);
    const diffFiles = await changedFileCount(worktree);
    const outputOk = checkOutputContains(
      parsed.final?.result ?? "",
      input.task.expect.outputContains,
      parsed.final?.is_error === true,
    );
    const success = outputOk && typecheckPassed !== false;

    return {
      schemaVersion: 1,
      taskId: input.task.id,
      route: input.route,
      observedRoute: observed,
      run: input.run,
      success,
      ccTokens: ccTokensFromModelUsage(parsed.final?.modelUsage),
      baselineCcTokens: input.baselineCcTokens,
      durationMs: Date.now() - started,
      routeHonored: routeHonored(input.route, observed, parsed.toolUses),
      testsPassed: typecheckPassed,
      filesChanged: diffFiles,
      workerCalls: parsed.toolUses.length,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      taskId: input.task.id,
      route: input.route,
      run: input.run,
      success: false,
      ccTokens: 0,
      baselineCcTokens: input.baselineCcTokens,
      durationMs: Date.now() - started,
      routeHonored: false,
      testsPassed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await execFilePromise("git", ["worktree", "remove", "--force", worktree], {
      cwd: input.repoRoot,
      timeout: 120_000,
    }).catch(() => undefined);
  }
}

function writeMcpConfig(
  route: RouteName,
  worktree: string,
  composerEntry: string,
): string {
  const mcpPath = path.join(worktree, `.composer-route-${route}.mcp.json`);
  if (route === "cc-only") {
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), "utf8");
    return mcpPath;
  }

  const configPath = path.join(worktree, `.composer-route-${route}.config.json`);
  const config = routeConfig(route);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        composer: {
          command: "node",
          args: [composerEntry],
          env: { COMPOSER_CONFIG: configPath },
        },
      },
    }),
    "utf8",
  );
  return mcpPath;
}

function routeConfig(route: RouteName): unknown {
  const base = {
    roles: {
      researcher: {
        provider: "cli",
        cli: ["codex", "--search", "--ask-for-approval", "never", "exec", "--sandbox", "read-only"],
      },
      coder: {
        provider: "anthropic",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      },
      reviewer: { provider: "cli", cli: ["agy", "--dangerously-skip-permissions", "-p"] },
      coderCli: {
        provider: "cli",
        cli: ["codex", "exec", "--sandbox", "workspace-write", "-c", "approval_policy=\"never\""],
      },
    },
    spendAuthorization: { mode: "auto", maxUsdPerCall: 0.5, maxUsdPerSession: 50 },
  };

  return base;
}

async function runTypecheck(worktree: string): Promise<boolean> {
  const nodeModules = path.join(worktree, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    try {
      fs.symlinkSync(path.resolve("node_modules"), nodeModules);
    } catch {
      return false;
    }
  }
  const tsc = path.join(nodeModules, ".bin", "tsc");
  const result = await execFilePromise(tsc, ["--noEmit"], {
    cwd: worktree,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => undefined);
  return result !== undefined;
}

async function changedFileCount(worktree: string): Promise<number> {
  const { stdout } = await execFilePromise("git", ["diff", "--name-only"], {
    cwd: worktree,
    timeout: 60_000,
  });
  return stdout.split(/\r?\n/).filter((line) => line.trim()).length;
}

function checkOutputContains(
  resultText: string,
  needles: ReadonlyArray<string> | undefined,
  isError: boolean,
): boolean {
  if (isError) return false;
  if (!needles || needles.length === 0) return true;
  const lower = resultText.toLowerCase();
  return needles.every((needle) => lower.includes(needle.toLowerCase()));
}

function loadTasks(tasksPath: string, taskFilter?: string): EvalTask[] {
  const rows = fs
    .readFileSync(tasksPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => EvalTaskSchema.parse(JSON.parse(line)));
  const selected = taskFilter ? rows.filter((task) => task.id === taskFilter) : rows;
  if (selected.length === 0) throw new Error(`no task matches --task ${taskFilter}`);
  return selected;
}

function loadBaselines(baselinePath: string): Map<string, number> {
  const map = new Map<string, number>();
  const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
    baselines?: Record<string, { mainSessionTokens?: number }>;
  };
  for (const [taskId, value] of Object.entries(parsed.baselines ?? {})) {
    if (typeof value.mainSessionTokens === "number" && value.mainSessionTokens > 0) {
      map.set(taskId, value.mainSessionTokens);
    }
  }
  return map;
}

function resolveComposerEntry(repoRoot: string, override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`--composer-entry not found: ${override}`);
    return override;
  }
  const local = path.resolve(repoRoot, "dist/index.js");
  if (fs.existsSync(local)) return local;
  if (fs.existsSync(INSTALLED_ENTRY)) return INSTALLED_ENTRY;
  throw new Error("no composer entry found; run npm run build or pass --composer-entry");
}

function execFilePromise(
  file: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr ?? "")
          .trim()
          .split(/\r?\n/)
          .slice(-3)
          .join(" | ");
        reject(new Error(`${error.message}${tail ? ` [stderr: ${tail}]` : ""}`));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function requireValue(argv: ReadonlyArray<string>, index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`route-compare: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
