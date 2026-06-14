// One-shot stock-baseline batch. For each task, runs a headless `claude -p`
// with NO composer MCP (--strict-mcp-config + empty config) in an isolated
// worktree, and records TOTAL-CC tokens (all Claude models = real Max5 burn).
// This is the "no offload" reference vs composer-with-offload. Writes
// evals/baselines.json (total-CC scope). Long-running — invoke in background:
//   tsx evals/scripts/baseline.ts [--model sonnet] [--budget-usd 0.5] [--task ID]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { EvalTaskSchema, type EvalTask } from "../../tests/eval/schema.js";

const CLEAN_BEFORE: Record<string, ReadonlyArray<string>> = {
  "t1-slugify": ["src/util/slug.ts"],
};

interface Args { model: string; budgetUsd: number; taskFilter?: string; runs: number }
function parseArgs(argv: ReadonlyArray<string>): Args {
  let model = "sonnet"; let budgetUsd = 0.5; let taskFilter: string | undefined; let runs = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") { const v = argv[++i]; if (v === undefined) throw new Error("--model needs value"); model = v; }
    else if (a === "--budget-usd") { const v = argv[++i]; if (v === undefined) throw new Error("--budget-usd needs value"); budgetUsd = parseFloat(v); }
    else if (a === "--task") { const v = argv[++i]; if (v === undefined) throw new Error("--task needs value"); taskFilter = v; }
    else if (a === "--runs") { const v = argv[++i]; if (v === undefined) throw new Error("--runs needs value"); runs = parseInt(v, 10); if (Number.isNaN(runs) || runs < 1) throw new Error(`--runs invalid: ${v}`); }
    else throw new Error(`unknown flag: ${a}`);
  }
  return { model, budgetUsd, taskFilter, runs };
}

interface MU { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
function ccTotal(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim(); if (!t) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    if (o.type === "result" && o.modelUsage && typeof o.modelUsage === "object") {
      for (const u of Object.values(o.modelUsage as Record<string, MU>)) {
        total += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      }
    }
  }
  return total;
}

async function runStock(task: EvalTask, model: string, budgetUsd: number, mcpCfg: string): Promise<{ cc: number; wallSeconds: number }> {
  const wt = `/tmp/composer-baseline-${process.pid}-${task.id}`;
  try {
    await new Promise<void>((res, rej) => execFile("git", ["worktree", "add", wt, "HEAD", "--detach"], {}, (e) => e ? rej(e) : res()));
    for (const rel of CLEAN_BEFORE[task.id] ?? []) fs.rmSync(path.join(wt, rel), { force: true });
    const start = Date.now();
    const stdout = await new Promise<string>((res, rej) => {
      const child = execFile("claude",
        ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
         "--mcp-config", mcpCfg, "--strict-mcp-config", "--model", model, "--max-budget-usd", String(budgetUsd), task.prompt],
        { maxBuffer: 16 * 1024 * 1024, cwd: wt, timeout: 600_000, killSignal: "SIGTERM" },
        (err, so) => err ? rej(new Error(err.message)) : res(so));
      child.stdin?.end();
    });
    const wallSeconds = Math.round((Date.now() - start) / 1000);
    return { cc: ccTotal(stdout), wallSeconds };
  } finally {
    await new Promise<void>((res) => execFile("git", ["worktree", "remove", "--force", wt], {}, () => res()));
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tasks: EvalTask[] = fs.readFileSync(path.resolve(here, "../tasks.jsonl"), "utf8")
    .trim().split("\n").map((l) => EvalTaskSchema.parse(JSON.parse(l)));
  const sel = args.taskFilter ? tasks.filter((t) => t.id === args.taskFilter) : tasks;

  const mcpCfg = `/tmp/composer-baseline-empty-${process.pid}.json`;
  fs.writeFileSync(mcpCfg, JSON.stringify({ mcpServers: {} }));

  const outPath = path.resolve(here, "../baselines.json");
  const existing = JSON.parse(fs.readFileSync(outPath, "utf8")) as { baselines: Record<string, unknown> };
  const baselines: Record<string, unknown> = { ...existing.baselines };

  console.log(`# Baseline batch — stock (no composer), model=${args.model}, ${sel.length} tasks`);
  for (let i = 0; i < sel.length; i++) {
    const task = sel[i]!;
    try {
      const ccs: number[] = [];
      const wallSeconds: number[] = [];
      for (let r = 0; r < args.runs; r++) {
        try {
          const result = await runStock(task, args.model, args.budgetUsd, mcpCfg);
          ccs.push(result.cc);
          wallSeconds.push(result.wallSeconds);
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
          console.error(`  ${task.id} run ${r + 1}/${args.runs} failed (skipped): ${msg}`);
        }
      }
      if (ccs.length === 0) throw new Error('all runs failed');
      const cc = median(ccs);
      const wall = median(wallSeconds);
      baselines[task.id] = { mainSessionTokens: cc, wallSeconds: wall, method: `stock total-CC (no composer MCP), ${args.model}, median of ${args.runs}` };
      console.log(`[${i + 1}/${sel.length}] ${task.id}: median=${cc} wallSeconds=${wall} runs=[${ccs.join(",")}]`);
    } catch (err) {
      console.error(`[${i + 1}/${sel.length}] ${task.id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    // incremental write so partial progress survives
    fs.writeFileSync(outPath, JSON.stringify({
      measuredAt: existing["measuredAt" as keyof typeof existing] ?? null,
      claudeModel: args.model, method: "stock total-CC scope (no composer MCP) — no-offload reference",
      baselines,
    }, null, 2) + "\n");
  }
  console.log(`done — wrote ${outPath}`);
}

main().catch((e: unknown) => { console.error("baseline: fatal:", e instanceof Error ? e.message : String(e)); process.exit(1); });
