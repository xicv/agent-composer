#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readAuditEvents, summarizeAudit, type AuditEvent } from "../src/util/auditLog.js";

export const DEFAULT_BUDGETS: Record<string, number> = {
  composer_route_decide: 50,
  composer_status: 50,
  composer_review_job_start: 100,
};

export function computePerfReport(events: AuditEvent[], budgets: Record<string, number>): {
  rows: Array<{ tool: string; count: number; p95: number; budgetMs: number | null; pass: boolean }>;
  ok: boolean;
} {
  const summary = summarizeAudit(events);
  const rows = Object.keys(summary.latencyByTool)
    .sort((a, b) => a.localeCompare(b))
    .map((tool) => {
      const latency = summary.latencyByTool[tool]!;
      const budgetMs = budgets[tool] ?? null;
      return {
        tool,
        count: latency.count,
        p95: latency.p95,
        budgetMs,
        pass: budgetMs === null ? true : latency.p95 < budgetMs,
      };
    });
  return { rows, ok: rows.every((row) => row.pass) };
}

function printRows(rows: Array<{ tool: string; count: number; p95: number; budgetMs: number | null; pass: boolean }>): void {
  const headers = ["tool", "count", "p95 ms", "budget (p95)", "result"];
  const rendered = rows.map((row) => [
    row.tool,
    String(row.count),
    row.p95.toFixed(2),
    row.budgetMs === null ? "-" : `< ${row.budgetMs} ms`,
    row.pass ? "PASS" : "FAIL",
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rendered.map((row) => row[index]!.length),
  ));
  const format = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ");
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-|-"));
  for (const row of rendered) console.log(format(row));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectDir = process.argv[2] ?? process.cwd();
  const events = readAuditEvents(projectDir, { limit: Number.MAX_SAFE_INTEGER });
  const report = computePerfReport(events, DEFAULT_BUDGETS);
  printRows(report.rows);
  if (!report.ok) process.exitCode = 1;
}
