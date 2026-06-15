import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAuditEvent } from "../../src/util/auditLog.js";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import { clearGoal, startGoal, stepGoal } from "../../src/util/goal.js";
import { buildGoalReport, recommendNext, renderGoalReportMarkdown } from "../../src/util/goalReport.js";
import type { GoalRecord } from "../../src/util/goal.js";

describe("goalReport", () => {
  let root: string;
  let stateDir: string;
  let previousComposerStateDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "composer-goal-report-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-goal-report-state-"));
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
  });

  afterEach(() => {
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads the active goal when no goalId is supplied and redacts commands by default", () => {
    startGoal(root, {
      objective: "report active",
      condition: "unit passes",
      checks: [{ name: "unit", command: "echo RAW_SECRET_COMMAND" }],
    });

    const report = buildGoalReport(root);

    expect("goal" in report && report.goal.state).toBe("active");
    expect(JSON.stringify(report)).toContain("unit");
    expect(JSON.stringify(report)).toContain("pending");
    expect(JSON.stringify(report)).not.toContain("RAW_SECRET_COMMAND");
  });

  it("reads a terminal goal by id", () => {
    const started = startGoal(root, {
      objective: "terminal report",
      condition: "cancelled",
    });
    clearGoal(root, started.goalId);

    const report = buildGoalReport(root, { goalId: started.goalId, includeAudit: false });

    expect("goal" in report && report.goal.state).toBe("cancelled");
  });

  it("markdown excludes raw command strings by default and includes them when requested", () => {
    startGoal(root, {
      objective: "redact markdown",
      condition: "check declared",
      checks: [{ name: "unit", command: "echo RAW_MARKDOWN_COMMAND" }],
    });

    const redacted = renderGoalReportMarkdown(buildGoalReport(root), {});
    const unredacted = renderGoalReportMarkdown(buildGoalReport(root, { includeCommands: true }), {
      includeCommands: true,
    });

    expect(redacted).toContain("| check | status | lastRunAt |");
    expect(redacted).toContain("unit");
    expect(redacted).toContain("pending");
    expect(redacted).not.toContain("RAW_MARKDOWN_COMMAND");
    expect(unredacted).toContain("RAW_MARKDOWN_COMMAND");
  });

  it("omits audit by default and includes project-wide counts only when requested", () => {
    appendAuditEvent(root, { kind: "route-decision", route: "composer_code_cli" });
    appendAuditEvent(root, { kind: "tool-call", tool: "composer_code_cli" });
    appendAuditEvent(root, { kind: "review", reviewVerdict: "approved" });
    appendAuditEvent(root, { kind: "test", testsPassed: true });
    appendAuditEvent(root, { kind: "outcome", status: "succeeded" });
    startGoal(root, {
      objective: "audit report",
      condition: "audit visible",
    });

    const defaultReport = buildGoalReport(root, { auditLimit: 3 });
    const report = buildGoalReport(root, { includeAudit: true, auditLimit: 3 });
    const withEvents = buildGoalReport(root, { includeAudit: true, auditLimit: 3, includeAuditEvents: true });

    expect("goal" in defaultReport && defaultReport.audit).toBeUndefined();
    expect("goal" in report && report.audit).toMatchObject({
      routeDecisions: 0,
      toolCalls: 0,
      reviews: 1,
      tests: 1,
      outcomes: 1,
      recent: [],
    });
    expect("goal" in withEvents && withEvents.audit?.recent).toHaveLength(3);
  });

  it("returns state none when no goal exists", () => {
    expect(buildGoalReport(root)).toEqual({ state: "none" });
  });

  it("falls back to the latest terminal goal when no active goal exists", () => {
    const started = startGoal(root, {
      objective: "terminal fallback",
      condition: "report without id works",
    });
    clearGoal(root, started.goalId);

    const report = buildGoalReport(root, { includeAudit: false });

    expect("goal" in report && report.goal).toMatchObject({
      goalId: started.goalId,
      state: "cancelled",
      objective: "terminal fallback",
    });
  });

  it("labels markdown audit as project-wide and gates recent events separately", () => {
    appendAuditEvent(root, { kind: "route-decision", route: "composer_code_cli" });
    startGoal(root, {
      objective: "markdown audit",
      condition: "events gated",
    });

    const defaultReport = renderGoalReportMarkdown(buildGoalReport(root), {});
    const redacted = renderGoalReportMarkdown(buildGoalReport(root, { includeAudit: true }), {});
    const unredacted = renderGoalReportMarkdown(buildGoalReport(root, {
      includeAudit: true,
      includeAuditEvents: true,
    }), {
      includeAuditEvents: true,
    });

    expect(defaultReport).not.toContain("routeDecisions=1");
    expect(redacted).toContain("## Recent project activity (not goal-scoped)");
    expect(redacted).toContain("- counts: routeDecisions=1");
    expect(redacted).not.toContain("- recent:");
    expect(redacted).not.toContain("route=composer_code_cli");
    expect(unredacted).toContain("- recent:");
    expect(unredacted).toContain("route=composer_code_cli");
  });

  it("recommendNext maps expected active, blocked, terminal, and vetoed states", () => {
    const pending = startGoal(root, {
      objective: "pending",
      condition: "check pending",
      checks: [{ name: "unit", command: "true" }],
      maxCost: 1,
    });
    expect(recommendNext(pending)).toMatchObject({
      nextAction: "composer_goal_status",
      reason: expect.stringContaining("pending checks: unit"),
    });

    const blocked = stepGoal(root, { goalId: pending.goalId, signals: { spentUsd: 10 } }).record;
    expect(recommendNext(blocked)).toEqual({
      nextAction: "composer_goal_step",
      reason: "blocked; extend budget (budgetExtension), report check results, or clear",
    });

    const failedLike = { ...blocked, state: "failed" as const } satisfies GoalRecord;
    expect(recommendNext(failedLike)).toEqual({
      nextAction: "composer_goal_report",
      reason: "goal failed within budget; review report",
    });

    const achievedLike = { ...blocked, state: "achieved" as const } satisfies GoalRecord;
    expect(recommendNext(achievedLike)).toEqual({
      nextAction: "none",
      reason: "goal achieved; review report",
    });

    const vetoed = {
      ...blocked,
      state: "active" as const,
      conditionMet: false,
      checks: blocked.checks.map((check) => ({ ...check, status: "pass" as const })),
    } satisfies GoalRecord;
    expect(recommendNext(vetoed)).toEqual({
      nextAction: "composer_code_cli",
      reason: "condition not yet met (caller veto)",
    });
  });
});
