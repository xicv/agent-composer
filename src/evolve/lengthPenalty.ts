// Wave 3 Step 2 — length penalty for bloat-drift control.
//
// score_adjusted = score_raw − λ · tokens(skill)
//
// Replaces the `remove_bloat` operator (excluded — 0% keep-rate per
// Karpathy data). λ default 0.001 means a 1000-token skill loses 1
// score point versus a 0-token skill — large enough to overcome
// noise, small enough to keep useful additions.
//
// Token estimator is intentionally crude (whitespace + bullets);
// the metric only needs to be monotonic in skill length to gate
// bloat — exact tiktoken counts add a dep for no gain here.

export const DEFAULT_LAMBDA = 0.001;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return text
    .split(/\s+|[-*]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export function lengthPenalty(skill: string, lambda: number = DEFAULT_LAMBDA): number {
  if (lambda < 0) {
    throw new Error(`lengthPenalty: lambda must be >= 0, got ${lambda}`);
  }
  if (!skill) return 0;
  return -lambda * estimateTokens(skill);
}
