#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootUrl = new URL("../", import.meta.url);
const srcUrl = (path) => new URL(path, rootUrl).href;

const { buildStatus, renderStatusLine } = await import(srcUrl("src/cli/status.ts"));
const { classifyDispatch } = await import(srcUrl("src/util/dispatchHint.ts"));
const { appendAuditEvent } = await import(srcUrl("src/util/auditLog.ts"));
const { startGoal, readActiveGoal, stepGoal } = await import(srcUrl("src/util/goal.ts"));
const { planWorkflow } = await import(srcUrl("src/util/workflowPlan.ts"));
const { summarizeLatency } = await import(srcUrl("src/util/percentile.ts"));

const previousStateDir = process.env.COMPOSER_STATE_DIR;
const tmp = mkdtempSync(join(tmpdir(), "composer-speed-bench-"));
process.env.COMPOSER_STATE_DIR = join(tmp, "state");

const budgets = [
  ["classifyDispatch (compact route decision)", 10, 1001, () => {
    classifyDispatch({
      prompt: "Fix src/cli/status.ts to add a compact --fast status line and tests.",
      description: "small local implementation",
    });
  }],
  ["composer_workflow_plan equivalent", 20, 1001, () => {
    planWorkflow({
      goal: "add session restore",
      workflow: "feature",
      mode: "fast",
      risk: "low",
      needsCurrentDocs: false,
    });
  }],
  ["goal_status with one active goal", 20, 501, null],
  ["goal_step with 3 checks (advisory, no exec)", 30, 151, null],
  ["status --line (clean temp repo)", 100, 151, null],
  ["status --line with 10k seeded audit events", 150, 151, null],
  ["status --fast --line", 50, 301, null],
];

try {
  const cleanProject = makeProject("clean");
  const auditProject = makeProject("audit");
  const goalProject = makeProject("goal");
  const fastProject = makeProject("fast");
  const stepProjects = Array.from({ length: 151 }, (_, i) => makeProject(`step-${i}`));

  startGoal(goalProject, {
    objective: "ship status speed path",
    condition: "status stays fast",
    checks: [{ name: "unit", command: "npm test" }],
  });

  for (const project of stepProjects) {
    startGoal(project, {
      objective: "advisory checks only",
      condition: "all checks pass",
      checks: [
        { name: "types", command: "npx tsc --noEmit" },
        { name: "unit", command: "npx vitest run" },
        { name: "scripts", command: "bash tests/scripts/run.sh" },
      ],
    });
  }

  for (let i = 0; i < 10_000; i += 1) {
    appendAuditEvent(auditProject, auditEventFor(i));
  }

  budgets[2][3] = () => {
    const record = readActiveGoal(goalProject);
    JSON.stringify(record
      ? {
          goalId: record.goalId,
          state: record.state,
          turns: record.turns,
          maxTurns: record.maxTurns,
          checks: record.checks,
          lastAction: record.lastAction,
          lastVerdict: record.lastVerdict,
          lastReason: record.lastReason,
        }
      : { state: "none" });
  };
  let stepIndex = 0;
  budgets[3][3] = () => {
    const project = stepProjects[stepIndex++ % stepProjects.length];
    const result = stepGoal(project, {});
    JSON.stringify({
      state: result.record.state,
      turns: result.record.turns,
      nextAction: result.nextAction,
      checks: result.record.checks,
      lastReason: result.record.lastReason,
    });
  };
  budgets[4][3] = () => renderStatusLine(buildStatus(cleanProject));
  budgets[5][3] = () => renderStatusLine(buildStatus(auditProject));
  budgets[6][3] = () => renderStatusLine(buildStatus(fastProject, { fast: true }));

  const rows = budgets.map(([name, budgetMs, iterations, fn]) => {
    const { p50, p95, p99 } = measureLatency(fn, iterations);
    return { name, p50, p95, p99, budgetMs, pass: p95 < budgetMs };
  });

  printRows(rows);
  if (rows.some((row) => !row.pass)) {
    process.exitCode = 1;
  }
} finally {
  if (previousStateDir === undefined) delete process.env.COMPOSER_STATE_DIR;
  else process.env.COMPOSER_STATE_DIR = previousStateDir;
  rmSync(tmp, { recursive: true, force: true });
}

function makeProject(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".keep"), "", { flag: "w" });
  writeFileSync(join(dir, "composer.config.json"), JSON.stringify({
    roles: {
      researcher: { provider: "mock", model: "researcher-mock" },
      coder: { provider: "mock", model: "coder-mock" },
      reviewer: { provider: "mock", model: "reviewer-mock" },
      oraclePlanner: { provider: "mock", model: "oracle-mock" },
    },
    codexReview: { enabled: true },
    codexLifecycle: { enabled: true },
  }, null, 2));
  return dir;
}

function auditEventFor(i) {
  switch (i % 5) {
    case 0:
      return { kind: "route-decision", route: "composer-code-cli", taskClass: "simple-code" };
    case 1:
      return { kind: "tool-call", tool: "composer_code_cli" };
    case 2:
      return { kind: "review", reviewVerdict: "approved" };
    case 3:
      return { kind: "test", testsPassed: true };
    default:
      return { kind: "outcome", status: "succeeded" };
  }
}

function measureLatency(fn, iterations) {
  for (let i = 0; i < Math.min(10, iterations); i += 1) fn();
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    fn();
    const ended = process.hrtime.bigint();
    samples.push(Number(ended - started) / 1_000_000);
  }
  return summarizeLatency(samples);
}

function printRows(rows) {
  const headers = ["op", "p50 ms", "p95 ms", "budget (p95)", "result"];
  const rendered = rows.map((row) => [
    row.name,
    row.p50.toFixed(2),
    row.p95.toFixed(2),
    `< ${row.budgetMs} ms`,
    row.pass ? "PASS" : "FAIL",
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rendered.map((row) => row[index].length),
  ));
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-|-"));
  for (const row of rendered) console.log(format(row));
}
