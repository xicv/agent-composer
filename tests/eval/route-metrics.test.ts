import { describe, expect, it } from "vitest";
import {
  formatRouteSummary,
  parseRouteRunJsonl,
  summarizeRouteRuns,
  type RouteRunRecord,
} from "./route-metrics.js";

const records: RouteRunRecord[] = [
  {
    schemaVersion: 1,
    taskId: "t1",
    route: "cc-only",
    run: 1,
    success: true,
    ccTokens: 1000,
    durationMs: 100,
    routeHonored: true,
    testsPassed: true,
    reviewPassed: true,
    filesChanged: 1,
  },
  {
    schemaVersion: 1,
    taskId: "t1",
    route: "cc-only",
    run: 2,
    success: true,
    ccTokens: 1200,
    durationMs: 120,
    routeHonored: true,
    testsPassed: true,
    reviewPassed: true,
    filesChanged: 1,
  },
  {
    schemaVersion: 1,
    taskId: "t1",
    route: "composer-codex-cli",
    observedRoute: "composer-codex-cli",
    run: 1,
    success: true,
    ccTokens: 350,
    durationMs: 180,
    routeHonored: true,
    testsPassed: true,
    reviewPassed: true,
    filesChanged: 1,
    workerCalls: 2,
  },
  {
    schemaVersion: 1,
    taskId: "t2",
    route: "composer-codex-cli",
    observedRoute: "composer-codex-cli",
    run: 1,
    success: false,
    ccTokens: 500,
    baselineCcTokens: 2000,
    durationMs: 210,
    routeHonored: false,
    testsPassed: false,
    reviewPassed: false,
    filesChanged: 2,
    workerCalls: 1,
  },
];

describe("route metrics", () => {
  it("parses strict JSONL records", () => {
    const parsed = parseRouteRunJsonl(records.map((row) => JSON.stringify(row)).join("\n"));
    expect(parsed).toHaveLength(records.length);
    expect(parsed[0]?.route).toBe("cc-only");
  });

  it("rejects malformed JSONL records with a useful line number", () => {
    expect(() => parseRouteRunJsonl("{\"schemaVersion\":1}\nnot-json")).toThrow(/line 1|line 2/);
  });

  it("summarizes success, route adherence, token medians, and savings", () => {
    const summary = summarizeRouteRuns(records);
    const baseline = summary.routes.find((route) => route.route === "cc-only");
    const codex = summary.routes.find((route) => route.route === "composer-codex-cli");

    expect(summary.runCount).toBe(4);
    expect(baseline?.medianCcTokens).toBe(1100);
    expect(codex?.successRate).toBe(0.5);
    expect(codex?.routeHonoredRate).toBe(0.5);
    expect(codex?.testsPassRate).toBe(0.5);
    expect(codex?.meanSavingsVsBaselinePct).toBe(71.6);
    expect((codex?.confidenceScore ?? 0) > 0).toBe(true);
  });

  it("formats a readable summary table", () => {
    const output = formatRouteSummary(summarizeRouteRuns(records));
    expect(output).toContain("route");
    expect(output).toContain("composer-codex-cli");
    expect(output).toContain("confidence");
  });
});
