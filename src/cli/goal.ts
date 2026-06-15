import { clearGoal, isTerminal, readActiveGoal, readGoal, startGoal, stepGoal } from "../util/goal.js";
import type { GoalCheck, GoalRecord, NextAction } from "../util/goal.js";
import { buildGoalReport, renderGoalReportMarkdown } from "../util/goalReport.js";
import type { GoalReportResult } from "../util/goalReport.js";

export type GoalAction = "start" | "status" | "step" | "clear" | "report";
type GoalBootstrapAction = {
  tool: "composer_route_decide";
  reason: string;
};

export interface GoalSummary {
  goalId?: string;
  state: string;
  turns?: number;
  maxTurns?: number;
  checks?: GoalCheck[];
  nextAction?: NextAction | GoalBootstrapAction;
  lastAction?: string;
  lastVerdict?: string;
  lastReason?: string;
  changed?: boolean;
}

export function runGoal(
  root: string,
  opts: { action: "report"; flags?: string[] },
): GoalReportResult;
export function runGoal(
  root: string,
  opts: { action?: Exclude<GoalAction, "report"> | string; flags?: string[] },
): GoalSummary;
export function runGoal(
  root: string,
  opts: { action?: string; flags?: string[] },
): GoalSummary | GoalReportResult {
  const action = opts.action;
  const flags = opts.flags ?? [];
  if (!isGoalAction(action)) {
    throw new Error(`composer goal: expected action start|status|step|clear|report (got ${action ?? "nothing"})`);
  }

  if (action === "report") {
    const report = buildGoalReport(root, {
      goalId: getFlagValue(flags, "--goal-id") ?? firstReportPositional(flags),
      includeAudit: flags.includes("--audit"),
      auditLimit: parseOptionalNonNegativeNumber(flags, "--audit-limit"),
      includeCommands: flags.includes("--include-commands"),
      includeAuditEvents: flags.includes("--include-audit-events"),
    });
    const format = parseReportFormat(flags);
    process.stdout.write(format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderGoalReportMarkdown(report, {
        includeCommands: flags.includes("--include-commands"),
        includeAuditEvents: flags.includes("--include-audit-events"),
      }));
    return report;
  }

  let summary: GoalSummary;
  if (action === "start") {
    const parsed = parseStartFlags(flags);
    const record = startGoal(root, parsed);
    summary = {
      goalId: record.goalId,
      state: record.state,
      turns: record.turns,
      checks: record.checks,
      nextAction: { tool: "composer_route_decide", reason: "begin" },
    };
  } else if (action === "status") {
    summary = summarizeStatus(readGoalByFlag(root, flags));
  } else if (action === "step") {
    const { record, nextAction } = stepGoal(root, {
      goalId: getFlagValue(flags, "--goal-id") ?? firstPositional(flags),
      signals: parseSignals(flags),
    });
    summary = summarizeRecord(record, nextAction);
  } else {
    const goalId = getFlagValue(flags, "--goal-id") ?? firstPositional(flags);
    const prior = goalId ? readGoal(root, goalId) : readActiveGoal(root);
    const record = clearGoal(root, goalId);
    summary = record
      ? {
          state: record.state,
          goalId: record.goalId,
          changed: prior !== null && !isTerminal(prior.state),
        }
      : { state: "none" };
  }

  process.stdout.write(`${formatGoalSummary(summary)}\n`);
  return summary;
}

function parseStartFlags(flags: string[]) {
  const positionals = positionalArgs(flags);
  const objective = getFlagValue(flags, "--objective") ?? positionals[0];
  const condition = getFlagValue(flags, "--condition") ?? positionals[1];
  if (!objective) throw new Error("composer goal start: missing objective");
  if (!condition) throw new Error("composer goal start: missing --condition");

  return {
    objective,
    condition,
    checks: getRepeatedFlagValues(flags, "--check").map(parseCheck),
    maxTurns: parseOptionalNonNegativeNumber(flags, "--max-turns"),
    maxCost: parseOptionalNonNegativeNumber(flags, "--max-cost"),
    workflow: getFlagValue(flags, "--workflow"),
    mode: getFlagValue(flags, "--mode"),
    risk: getFlagValue(flags, "--risk"),
  };
}

function parseCheck(value: string): { name: string; command: string } {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`composer goal start: expected --check name=command (got ${value})`);
  }
  return { name: value.slice(0, index), command: value.slice(index + 1) };
}

function parseSignals(flags: string[]) {
  const failedAttempts = parseOptionalNonNegativeNumber(flags, "--failed-attempts");
  const maxTurns = parseOptionalNonNegativeNumber(flags, "--raise-max-turns");
  const maxCost = parseOptionalNonNegativeNumber(flags, "--raise-max-cost");
  const conditionMet = flags.includes("--condition-met");
  const conditionNotMet = flags.includes("--condition-not-met");
  if (conditionMet && conditionNotMet) {
    throw new Error("--condition-met and --condition-not-met are mutually exclusive");
  }
  const budgetExtension = maxTurns !== undefined || maxCost !== undefined
    ? { maxTurns, maxCost }
    : undefined;
  return {
    checkResults: getRepeatedFlagValues(flags, "--check-result").map(parseCheckResult),
    conditionMet: conditionMet ? true : conditionNotMet ? false : undefined,
    spentUsd: parseOptionalNonNegativeNumber(flags, "--spent"),
    failedAttempts,
    stuck: flags.includes("--stuck") ? true : undefined,
    budgetExtension,
    testsPassed: flags.includes("--tests-passed") ? true : flags.includes("--tests-failed") ? false : undefined,
    reviewVerdict: getFlagValue(flags, "--review-verdict"),
  };
}

function parseCheckResult(value: string): { name: string; passed: boolean } {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`composer goal step: expected --check-result name=pass|fail (got ${value})`);
  }
  const status = value.slice(index + 1);
  if (status !== "pass" && status !== "fail") {
    throw new Error(`composer goal step: expected --check-result name=pass|fail (got ${value})`);
  }
  return { name: value.slice(0, index), passed: status === "pass" };
}

function readGoalByFlag(root: string, flags: string[]): GoalRecord | null {
  const goalId = getFlagValue(flags, "--goal-id") ?? firstPositional(flags);
  return goalId ? readGoal(root, goalId) : readActiveGoal(root);
}

function summarizeStatus(record: GoalRecord | null): GoalSummary {
  if (!record) return { state: "none" };
  return {
    goalId: record.goalId,
    state: record.state,
    turns: record.turns,
    maxTurns: record.maxTurns,
    checks: record.checks,
    lastAction: record.lastAction,
    lastVerdict: record.lastVerdict,
    lastReason: record.lastReason,
  };
}

function summarizeRecord(record: GoalRecord, nextAction: NextAction): GoalSummary {
  return {
    goalId: record.goalId,
    state: record.state,
    turns: record.turns,
    checks: record.checks,
    nextAction,
    lastReason: record.lastReason,
  };
}

function formatGoalSummary(summary: GoalSummary): string {
  if (summary.state === "none") return "goal:none · no active goal";
  if (summary.changed === false && summary.goalId) {
    return `goal:${summary.state} · id:${summary.goalId} · already ${summary.state} (unchanged)`;
  }
  const parts = [`goal:${summary.state}`];
  if (summary.goalId) parts.push(`id:${summary.goalId}`);
  if (summary.turns !== undefined) parts.push(`${summary.turns}t`);
  if (summary.maxTurns !== undefined) parts.push(`max:${summary.maxTurns}t`);
  if (summary.nextAction) parts.push(`next:${summary.nextAction.tool}`);
  else if (summary.lastAction) parts.push(`last:${summary.lastAction}`);
  if (summary.nextAction?.reason ?? summary.lastReason) {
    parts.push(`reason:${summary.nextAction?.reason ?? summary.lastReason}`);
  }
  return parts.join(" · ");
}

function isGoalAction(action: string | undefined): action is GoalAction {
  return action === "start" || action === "status" || action === "step" || action === "clear" || action === "report";
}

function parseReportFormat(flags: string[]): "json" | "markdown" {
  const format = getFlagValue(flags, "--format") ?? "markdown";
  if (format !== "json" && format !== "markdown") {
    throw new Error(`composer goal report: --format expects markdown|json, got "${format}"`);
  }
  return format;
}

function getFlagValue(flags: string[], name: string): string | undefined {
  for (let i = 0; i < flags.length; i++) {
    const value = flags[i]!;
    if (value === name) return flags[i + 1];
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}

function getRepeatedFlagValues(flags: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const value = flags[i]!;
    if (value === name && flags[i + 1]) values.push(flags[i + 1]!);
    else if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
  }
  return values;
}

function firstPositional(flags: string[]): string | undefined {
  return positionalArgs(flags)[0];
}

const REPORT_VALUE_FLAGS = new Set(["--audit-limit", "--format", "--goal-id"]);

function firstReportPositional(flags: string[]): string | undefined {
  return positionalArgs(flags, REPORT_VALUE_FLAGS)[0];
}

function positionalArgs(flags: string[], valueFlags?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const value = flags[i]!;
    if (value.startsWith("--")) {
      const flagName = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      const consumesValue = valueFlags ? valueFlags.has(flagName) : !value.includes("=");
      if (consumesValue && !value.includes("=") && flags[i + 1] && !flags[i + 1]!.startsWith("--")) i += 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

function parseOptionalNonNegativeNumber(flags: string[], name: string): number | undefined {
  const value = getPresentFlagValue(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} expects a non-negative number, got "${value}"`);
  }
  return parsed;
}

function getPresentFlagValue(flags: string[], name: string): string | undefined {
  for (let i = 0; i < flags.length; i++) {
    const value = flags[i]!;
    if (value === name) {
      const next = flags[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${name} expects a value`);
      }
      return next;
    }
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}
