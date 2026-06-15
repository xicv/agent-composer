import { describe, it, expect } from "vitest";
import { computePerfReport } from "../../scripts/perf-report.js";
import type { AuditEvent } from "../../src/util/auditLog.js";

const baseEvent = {
  ts: "2026-06-15T00:00:00.000Z",
  kind: "tool-call",
} satisfies Pick<AuditEvent, "ts" | "kind">;

describe("computePerfReport", () => {
  it("computes rows from tool-call durations and applies p95 budgets", () => {
    const events: AuditEvent[] = [
      { ...baseEvent, tool: "composer_status", durationMs: 10 },
      { ...baseEvent, tool: "composer_status", durationMs: 20 },
      { ...baseEvent, tool: "composer_status", durationMs: 30 },
      { ...baseEvent, tool: "composer_route_decide", durationMs: 80 },
      { ...baseEvent, tool: "composer_route_decide", durationMs: 120 },
      { ...baseEvent, tool: "composer_unknown", durationMs: 500 },
      { ...baseEvent, tool: "composer_status" },
      { ...baseEvent, durationMs: 100 },
    ];

    const report = computePerfReport(events, {
      composer_status: 50,
      composer_route_decide: 100,
    });

    expect(report.rows).toEqual([
      { tool: "composer_route_decide", count: 2, p95: 120, budgetMs: 100, pass: false },
      { tool: "composer_status", count: 3, p95: 30, budgetMs: 50, pass: true },
      { tool: "composer_unknown", count: 1, p95: 500, budgetMs: null, pass: true },
    ]);
    expect(report.ok).toBe(false);
  });

  it("reports ok when all budgeted rows pass and unbudgeted rows are present", () => {
    const events: AuditEvent[] = [
      { ...baseEvent, tool: "composer_status", durationMs: 10 },
      { ...baseEvent, tool: "composer_extra", durationMs: 500 },
    ];

    const report = computePerfReport(events, { composer_status: 50 });

    expect(report.rows.find((row) => row.tool === "composer_extra")?.pass).toBe(true);
    expect(report.ok).toBe(true);
  });
});
