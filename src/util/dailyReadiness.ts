import type { DoctorCheck, DoctorReport } from "../cli/doctor.js";
import type { ComposerStatus } from "../cli/status.js";
import { renderStatusLine } from "../cli/status.js";

export type DailyReadinessState = "ready" | "degraded" | "disabled" | "blocked";

export interface ReadinessIssue {
  name: string;
  detail: string;
  action?: string;
}

export interface DailyReadiness {
  version: 1;
  generatedAt: string;
  state: DailyReadinessState;
  summary: string;
  statusLine: string;
  nextAction?: string;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
  doctor: {
    healthy: boolean;
    checks: DoctorCheck[];
  };
  status: ComposerStatus;
}

export interface BuildDailyReadinessInput {
  status: ComposerStatus;
  doctor: DoctorReport;
  generatedAt?: string;
  statusLine?: string;
}

export function buildDailyReadiness(input: BuildDailyReadinessInput): DailyReadiness {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const blockers = collectBlockers(input.status, input.doctor);
  const warnings = collectWarnings(input.status, input.doctor);
  const state = classifyState(input.status, blockers, warnings);
  const nextAction = readinessNextAction(state, input.status, blockers, warnings);

  return {
    version: 1,
    generatedAt,
    state,
    summary: readinessSummary(state, blockers.length, warnings.length),
    statusLine: input.statusLine ?? renderStatusLine(input.status),
    nextAction,
    blockers,
    warnings,
    doctor: {
      healthy: input.doctor.healthy,
      checks: input.doctor.checks,
    },
    status: input.status,
  };
}

export function renderDailyReadinessHuman(readiness: DailyReadiness): string {
  const lines = [
    "composer readiness",
    `  state:            ${readiness.state}`,
    `  summary:          ${readiness.summary}`,
    `  status:           ${readiness.statusLine}`,
  ];
  if (readiness.blockers.length > 0) {
    lines.push("  blockers:");
    pushIssues(lines, readiness.blockers);
  }
  if (readiness.warnings.length > 0) {
    lines.push("  warnings:");
    pushIssues(lines, readiness.warnings);
  }
  if (readiness.nextAction) {
    lines.push(`  next:             ${readiness.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

export function dailyReadinessExitCode(readiness: Pick<DailyReadiness, "state">): number {
  return readiness.state === "blocked" || readiness.state === "disabled" ? 1 : 0;
}

function collectBlockers(status: ComposerStatus, doctor: DoctorReport): ReadinessIssue[] {
  const blockers: ReadinessIssue[] = [];
  if (!status.config.exists) {
    blockers.push({
      name: "config",
      detail: "composer.config.json was not found or could not be loaded",
      action: "agent-composer init",
    });
  }
  for (const check of doctor.checks) {
    if (check.status !== "fail") continue;
    blockers.push({
      name: check.name,
      detail: check.detail,
      action: "agent-composer doctor",
    });
  }
  return dedupeIssues(blockers);
}

function collectWarnings(status: ComposerStatus, doctor: DoctorReport): ReadinessIssue[] {
  const warnings: ReadinessIssue[] = [];
  if (status.integrations.gitHook === "warn") {
    warnings.push({
      name: "git: pre-commit hook",
      detail: "Composer hook is installed but not in terminal-blocking --git-hook mode",
      action: "agent-composer install-git-hook",
    });
  }
  for (const warning of status.executorProfile.warnings) {
    warnings.push({
      name: "executor profile",
      detail: warning,
      action: "agent-composer status --json",
    });
  }
  if (status.goal?.state === "blocked") {
    warnings.push({
      name: "goal",
      detail: status.goal.nextReason ?? "active Composer goal is blocked",
      action: "composer_goal_step",
    });
  }
  if (status.latest.testsPassed === false) {
    warnings.push({
      name: "latest tests",
      detail: "latest recorded test audit event failed",
      action: "composer_audit_read",
    });
  }
  if (isAttentionVerdict(status.latest.reviewVerdict)) {
    warnings.push({
      name: "latest review",
      detail: `latest review verdict is ${status.latest.reviewVerdict}`,
      action: "composer_audit_read",
    });
  }
  for (const check of doctor.checks) {
    if (check.status !== "warn") continue;
    warnings.push({
      name: check.name,
      detail: check.detail,
      action: "agent-composer doctor",
    });
  }
  return dedupeIssues(warnings);
}

function classifyState(
  status: ComposerStatus,
  blockers: ReadinessIssue[],
  warnings: ReadinessIssue[],
): DailyReadinessState {
  if (status.integrations.composerDisabled) return "disabled";
  if (blockers.length > 0) return "blocked";
  if (hasDegradingWarning(warnings)) return "degraded";
  return "ready";
}

function hasDegradingWarning(warnings: ReadinessIssue[]): boolean {
  return warnings.some((warning) =>
    warning.name === "git: pre-commit hook" ||
    warning.name === "executor profile" ||
    warning.name === "goal" ||
    warning.name === "latest tests" ||
    warning.name === "latest review",
  );
}

function readinessNextAction(
  state: DailyReadinessState,
  status: ComposerStatus,
  blockers: ReadinessIssue[],
  warnings: ReadinessIssue[],
): string | undefined {
  if (state === "disabled") return "/composer enable";
  if (state === "blocked") return blockers[0]?.action ?? "agent-composer doctor";
  if (state === "degraded") {
    return warnings.find((warning) => hasDegradingWarning([warning]))?.action ?? status.recommendation.nextAction;
  }
  return status.recommendation.nextAction;
}

function readinessSummary(
  state: DailyReadinessState,
  blockerCount: number,
  warningCount: number,
): string {
  if (state === "disabled") return "Composer is disabled for this project or session.";
  if (state === "blocked") return `Composer is not ready: ${blockerCount} blocker${blockerCount === 1 ? "" : "s"} need attention.`;
  if (state === "degraded") return `Composer is usable, but ${warningCount} signal${warningCount === 1 ? "" : "s"} need attention.`;
  if (warningCount > 0) return `Composer is ready for daily use with ${warningCount} advisory warning${warningCount === 1 ? "" : "s"}.`;
  return "Composer is ready for daily use.";
}

function isAttentionVerdict(verdict: string | undefined): boolean {
  if (!verdict) return false;
  return /needs|fail|block|attention|reject/i.test(verdict);
}

function pushIssues(lines: string[], issues: ReadinessIssue[]): void {
  for (const issue of issues) {
    const action = issue.action ? ` (next: ${issue.action})` : "";
    lines.push(`    - ${issue.name}: ${issue.detail}${action}`);
  }
}

function dedupeIssues(issues: ReadinessIssue[]): ReadinessIssue[] {
  const seen = new Set<string>();
  const out: ReadinessIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.name}\0${issue.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}
