import {
  CodexLifecycleEventSchema,
  CodexLifecycleSchema,
  type CodexLifecycleEvent,
  type CodexLifecycleInput,
} from "../config/schema.js";

export type CodexLifecycleAction = "skip" | "ask" | "run";
export type CodexLifecycleRisk = "low" | "medium" | "high" | "critical";

export interface CodexLifecycleSignals {
  expectedOutputTokens?: number;
  changedFiles?: number;
  diffLines?: number;
  failedAttempts?: number;
  failingTests?: boolean;
  touchesSecurity?: boolean;
  touchesInfra?: boolean;
  userRequestedCodex?: boolean;
  hasHandoff?: boolean;
  isTrivial?: boolean;
  isDestructive?: boolean;
  risk?: CodexLifecycleRisk;
}

export interface ResolvedCodexLifecycle {
  enabled: boolean;
  mode: "ask" | "auto";
  execution: "foreground" | "background";
  model: string;
  triggers: {
    postResearch: boolean;
    postPlan: boolean;
    postCodeApply: boolean;
    postTestFailure: boolean;
    afterFailedAttempts: boolean;
    preCommit: boolean;
    stopWarm: boolean;
  };
  thresholds: {
    minScore: number;
    minExpectedOutputTokens: number;
    minChangedFiles: number;
    minDiffLines: number;
    failedAttempts: number;
  };
  fallback: {
    enabled: boolean;
    order: Array<"researcher" | "coder" | "reviewer" | "reviewerClaude" | "coderCli">;
  };
}

export interface CodexLifecycleDecision {
  event: CodexLifecycleEvent;
  action: CodexLifecycleAction;
  score: number;
  threshold: number;
  model: string;
  execution: "foreground" | "background";
  reasons: string[];
}

const RISK_SCORE: Record<CodexLifecycleRisk, number> = {
  low: 0,
  medium: 10,
  high: 25,
  critical: 35,
};

export function resolveCodexLifecycle(
  lifecycle: CodexLifecycleInput | undefined,
): ResolvedCodexLifecycle {
  return CodexLifecycleSchema.parse(lifecycle ?? {});
}

export function decideCodexLifecycle(
  lifecycle: CodexLifecycleInput | undefined,
  event: CodexLifecycleEvent,
  signals: CodexLifecycleSignals = {},
): CodexLifecycleDecision {
  const resolved = resolveCodexLifecycle(lifecycle);
  const parsedEvent = CodexLifecycleEventSchema.parse(event);
  const reasons: string[] = [];

  if (!resolved.enabled) {
    return decision(parsedEvent, "skip", 0, resolved, ["codexLifecycle disabled"]);
  }
  if (!resolved.triggers[parsedEvent]) {
    return decision(parsedEvent, "skip", 0, resolved, [`trigger ${parsedEvent} disabled`]);
  }
  if (signals.isDestructive) {
    return decision(parsedEvent, "skip", 0, resolved, ["destructive action needs human control"]);
  }

  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (signals.userRequestedCodex) add(100, "user explicitly requested Codex");

  const expectedOutputTokens = signals.expectedOutputTokens ?? 0;
  if (expectedOutputTokens >= resolved.thresholds.minExpectedOutputTokens) {
    add(20, `expected output >= ${resolved.thresholds.minExpectedOutputTokens} tokens`);
  }

  const changedFiles = signals.changedFiles ?? 0;
  if (changedFiles >= resolved.thresholds.minChangedFiles) {
    add(15, `changed files >= ${resolved.thresholds.minChangedFiles}`);
  }

  const diffLines = signals.diffLines ?? 0;
  if (diffLines >= resolved.thresholds.minDiffLines) {
    add(15, `diff lines >= ${resolved.thresholds.minDiffLines}`);
  }

  const failedAttempts = signals.failedAttempts ?? 0;
  if (failedAttempts >= resolved.thresholds.failedAttempts) {
    add(35, `failed attempts >= ${resolved.thresholds.failedAttempts}`);
  }

  if (parsedEvent === "postTestFailure" && signals.failingTests) {
    add(30, "test failure needs second opinion");
  }
  if (parsedEvent === "afterFailedAttempts") {
    add(15, "failed-attempt lifecycle event");
  }
  if (parsedEvent === "postPlan") {
    add(10, "plan review before code");
  }
  if (parsedEvent === "postCodeApply") {
    add(10, "code was applied");
  }
  if (parsedEvent === "stopWarm") {
    add(5, "passive stop-time warm check");
  }

  if (signals.touchesSecurity) add(25, "security-sensitive surface");
  if (signals.touchesInfra) add(20, "infrastructure-sensitive surface");
  if (signals.hasHandoff) add(5, "shared handoff available");

  const risk = signals.risk ?? "low";
  const riskScore = RISK_SCORE[risk];
  if (riskScore > 0) add(riskScore, `${risk} risk`);

  if (signals.isTrivial) {
    score -= 60;
    reasons.push("trivial task penalty");
  }

  score = clampScore(score);
  if (score < resolved.thresholds.minScore) {
    if (reasons.length === 0) reasons.push("score below threshold");
    return decision(parsedEvent, "skip", score, resolved, reasons);
  }

  return decision(
    parsedEvent,
    resolved.mode === "auto" ? "run" : "ask",
    score,
    resolved,
    reasons,
  );
}

function decision(
  event: CodexLifecycleEvent,
  action: CodexLifecycleAction,
  score: number,
  resolved: ResolvedCodexLifecycle,
  reasons: string[],
): CodexLifecycleDecision {
  return {
    event,
    action,
    score,
    threshold: resolved.thresholds.minScore,
    model: resolved.model,
    execution: resolved.execution,
    reasons,
  };
}

function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}
