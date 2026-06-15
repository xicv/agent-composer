import { readAuditEvents } from "./auditLog.js";
import type { AuditEvent } from "./auditLog.js";
import { isTerminal, readActiveGoal, readGoal, readLatestGoal } from "./goal.js";
import type { GoalRecord, GoalState } from "./goal.js";

export interface GoalReportOptions {
  goalId?: string;
  includeAudit?: boolean;
  auditLimit?: number;
  includeCommands?: boolean;
  includeAuditEvents?: boolean;
}

export interface GoalReport {
  goal: {
    goalId: string;
    state: GoalState;
    objective: string;
    condition: string;
    turns: number;
    maxTurns: number;
    spentUsd?: number;
    maxCost?: number;
    checks: Array<{ name: string; status: string; lastRunAt?: string; command?: string }>;
    lastAction?: string;
    lastVerdict?: string;
    lastReason?: string;
  };
  audit?: {
    routeDecisions: number;
    toolCalls: number;
    reviews: number;
    tests: number;
    outcomes: number;
    recent: AuditEvent[];
  };
  recommendation: ReturnType<typeof recommendNext>;
}

export type GoalReportResult = GoalReport | { state: "none" };

export function recommendNext(record: GoalRecord): { nextAction: string; reason: string } {
  if (isTerminal(record.state)) {
    if (record.state === "achieved") return { nextAction: "none", reason: "goal achieved; review report" };
    if (record.state === "failed") {
      return { nextAction: "composer_goal_report", reason: "goal failed within budget; review report" };
    }
    return { nextAction: "none", reason: "goal cancelled" };
  }

  if (record.state === "blocked") {
    return {
      nextAction: "composer_goal_step",
      reason: "blocked; extend budget (budgetExtension), report check results, or clear",
    };
  }

  const pending = record.checks.filter((check) => check.status === "pending");
  if (pending.length > 0) {
    return {
      nextAction: "composer_goal_status",
      reason: `pending checks: ${pending.map((check) => check.name).join(", ")} — run them, report via composer_goal_step`,
    };
  }

  if (record.checks.some((check) => check.status === "fail")) {
    return { nextAction: "composer_code_cli", reason: "checks failing — fix" };
  }

  const allPass = record.checks.length === 0 || record.checks.every((check) => check.status === "pass");
  if (allPass && record.conditionMet === false) {
    return { nextAction: "composer_code_cli", reason: "condition not yet met (caller veto)" };
  }

  return { nextAction: "composer_goal_step", reason: "advance the goal loop" };
}

export function buildGoalReport(root: string, opts: GoalReportOptions = {}): GoalReportResult {
  const record = opts.goalId ? readGoal(root, opts.goalId) : readActiveGoal(root) ?? readLatestGoal(root);
  if (!record) return { state: "none" };

  const includeCommands = opts.includeCommands === true;
  const report: GoalReport = {
    goal: {
      goalId: record.goalId,
      state: record.state,
      objective: record.objective,
      condition: record.condition,
      turns: record.turns,
      maxTurns: record.maxTurns,
      spentUsd: record.spentUsd,
      maxCost: record.maxCost,
      checks: record.checks.map((check) => ({
        name: check.name,
        status: check.status,
        lastRunAt: check.lastRunAt,
        ...(includeCommands ? { command: check.command } : {}),
      })),
      lastAction: record.lastAction,
      lastVerdict: record.lastVerdict,
      lastReason: record.lastReason,
    },
    recommendation: recommendNext(record),
  };

  if (opts.includeAudit === true) {
    const limit = normalizeAuditLimit(opts.auditLimit);
    const recent = readAuditEvents(root, { limit });
    report.audit = {
      routeDecisions: countKind(recent, "route-decision"),
      toolCalls: countKind(recent, "tool-call"),
      reviews: countKind(recent, "review"),
      tests: countKind(recent, "test"),
      outcomes: countKind(recent, "outcome"),
      // Goal records do not currently store a runId, so raw project audit
      // events require an explicit opt-in to avoid cross-goal data leakage.
      recent: opts.includeAuditEvents === true ? recent : [],
    };
  }

  return report;
}

export function renderGoalReportMarkdown(
  report: GoalReportResult,
  opts: { includeCommands?: boolean; includeAuditEvents?: boolean } = {},
): string {
  if ("state" in report) return "# Goal Report\n\n_No goal found._\n";

  const full = report;
  const includeCommands = opts.includeCommands === true;
  const includeAuditEvents = opts.includeAuditEvents === true;
  const lines = ["# Goal Report", "", "## Goal"];
  lines.push(`- id: ${full.goal.goalId}`);
  lines.push(`- state: ${full.goal.state}`);
  lines.push(`- objective: ${full.goal.objective}`);
  lines.push(`- condition: ${full.goal.condition}`);
  lines.push(`- turns: ${full.goal.turns}/${full.goal.maxTurns}`);
  if (full.goal.spentUsd !== undefined || full.goal.maxCost !== undefined) {
    lines.push(`- cost: ${full.goal.spentUsd ?? 0}${full.goal.maxCost !== undefined ? `/${full.goal.maxCost}` : ""}`);
  }

  lines.push("", "## Checks");
  if (full.goal.checks.length === 0) {
    lines.push("_No checks declared._");
  } else {
    const header = includeCommands
      ? "| check | status | lastRunAt | command |"
      : "| check | status | lastRunAt |";
    const divider = includeCommands ? "| --- | --- | --- | --- |" : "| --- | --- | --- |";
    lines.push(header, divider);
    for (const check of full.goal.checks) {
      const cells = [
        escapeTableCell(check.name),
        escapeTableCell(check.status),
        escapeTableCell(check.lastRunAt ?? "-"),
      ];
      if (includeCommands) cells.push(escapeTableCell(check.command ?? "-"));
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }

  lines.push("", "## Last action");
  if (full.goal.lastAction || full.goal.lastVerdict || full.goal.lastReason) {
    if (full.goal.lastAction) lines.push(`- action: ${full.goal.lastAction}`);
    if (full.goal.lastVerdict) lines.push(`- verdict: ${full.goal.lastVerdict}`);
    if (full.goal.lastReason) lines.push(`- reason: ${full.goal.lastReason}`);
  } else {
    lines.push("_No recorded action._");
  }

  if (full.audit) {
    lines.push("", "## Recent project activity (not goal-scoped)");
    lines.push("- audit scope: recent project events; goal records do not store runId");
    lines.push(
      `- counts: routeDecisions=${full.audit.routeDecisions}, toolCalls=${full.audit.toolCalls}, reviews=${full.audit.reviews}, tests=${full.audit.tests}, outcomes=${full.audit.outcomes}`,
    );
    if (includeAuditEvents && full.audit.recent.length > 0) {
      lines.push("- recent:");
      for (const event of full.audit.recent) {
        lines.push(`  - ${event.ts} ${event.kind}${formatAuditEvent(event)}`);
      }
    }
  }

  lines.push("", "## Recommendation");
  lines.push(`- nextAction: ${full.recommendation.nextAction}`);
  lines.push(`- reason: ${full.recommendation.reason}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function countKind(events: AuditEvent[], kind: AuditEvent["kind"]): number {
  return events.filter((event) => event.kind === kind).length;
}

function normalizeAuditLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.floor(value));
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatAuditEvent(event: AuditEvent): string {
  const fields = [
    event.route ? `route=${event.route}` : undefined,
    event.tool ? `tool=${event.tool}` : undefined,
    event.reviewVerdict ? `review=${event.reviewVerdict}` : undefined,
    event.testsPassed !== undefined ? `tests=${event.testsPassed ? "pass" : "fail"}` : undefined,
    event.status ? `status=${event.status}` : undefined,
  ].filter((field): field is string => field !== undefined);
  return fields.length > 0 ? ` (${fields.join(", ")})` : "";
}
