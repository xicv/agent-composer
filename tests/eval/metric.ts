// Wave 2 F2.2 — composite scoring per plan §7.
//
//   task_score = 0.5 * success(0|1)
//              + 0.3 * (1 - main_session_tokens / baseline)
//              + 0.2 * dispatched_correctly(0|1)
//
// Weights are config-overridable (must sum to 1.0). The baseline must
// be measured ONCE on stock Claude Max5 — see evals/SUCCESS.md.

import type { EvalResult, SubagentRole } from "./schema.js";

export interface EvaluateDispatchInput {
  actualSequence: ReadonlyArray<SubagentRole>;
  expectedSequence: ReadonlyArray<SubagentRole>;
  /** Defaults to true (strict — must match expected sequence to be correct). */
  dispatchRequired?: boolean;
  /** Whether the orchestrator-side answer succeeded by output check. */
  success: boolean;
}

/**
 * Resolves whether an orchestrator's actual routing was the correct
 * choice given the task's expected dispatch contract.
 *
 * Strict (dispatchRequired=true): actual must equal expected.
 * Lenient (dispatchRequired=false): no-dispatch + success is correct
 * (thin-task carve-out); dispatch-then-wrong-subagent is still wrong.
 */
export function evaluateDispatch(input: EvaluateDispatchInput): boolean {
  const { actualSequence, expectedSequence, success } = input;
  const required = input.dispatchRequired ?? true;
  const actualMatchesExpected =
    actualSequence.length === expectedSequence.length &&
    actualSequence.every((r, i) => r === expectedSequence[i]);

  if (required) return actualMatchesExpected;

  // Lenient: no dispatch is OK iff inline answer succeeded.
  if (actualSequence.length === 0) return success;

  // Dispatch happened anyway — must still match the expected sequence.
  return actualMatchesExpected;
}

export interface MetricConfig {
  baselineMainTokens: number;
  successWeight?: number;
  tokenWeight?: number;
  dispatchWeight?: number;
}

const DEFAULTS = { success: 0.5, token: 0.3, dispatch: 0.2 };

export interface TaskScore {
  taskId: string;
  score: number;
  components: { success: number; token: number; dispatch: number };
}

export function scoreTask(
  result: EvalResult,
  config: MetricConfig,
): TaskScore {
  const w = {
    success: config.successWeight ?? DEFAULTS.success,
    token: config.tokenWeight ?? DEFAULTS.token,
    dispatch: config.dispatchWeight ?? DEFAULTS.dispatch,
  };
  const sum = w.success + w.token + w.dispatch;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`metric weights must sum to 1.0, got ${sum.toFixed(4)}`);
  }
  if (config.baselineMainTokens < 0) {
    throw new Error("baselineMainTokens must be >= 0");
  }

  const tokenRatio =
    config.baselineMainTokens > 0
      ? Math.max(0, 1 - result.mainSessionTokens / config.baselineMainTokens)
      : 0;

  const components = {
    success: w.success * (result.success ? 1 : 0),
    token: w.token * tokenRatio,
    dispatch: w.dispatch * (result.dispatchedCorrectly ? 1 : 0),
  };

  return {
    taskId: result.taskId,
    score: components.success + components.token + components.dispatch,
    components,
  };
}

export function aggregateScore(scores: ReadonlyArray<TaskScore>): number {
  if (scores.length === 0) return 0;
  return scores.reduce((acc, s) => acc + s.score, 0) / scores.length;
}
