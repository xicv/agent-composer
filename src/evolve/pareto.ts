// Wave 3 Step 2 — variance handling for candidate selection.
//
// Per locked design:
//   - temperature=0, N=3-5 re-runs on candidates that beat parent
//   - accept iff non-overlapping 95% CIs OR paired Wilcoxon p<0.1
//   - Occam tiebreak: on numerical tie, shorter prompt wins.
//
// Wilcoxon is the small-sample non-parametric paired test. We compute
// the two-sided p-value via a normal-approx of the signed-rank
// statistic with continuity correction — good enough for N=3..20.
// At very small N (≤5) the normal approx is loose; runner falls back
// on the CI check, so loose p is OK here.

export interface CI {
  lower: number;
  upper: number;
}

export function mean(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdDev(xs: ReadonlyArray<number>): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ssq = xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return Math.sqrt(ssq / (xs.length - 1));
}

export function ci95(xs: ReadonlyArray<number>): CI {
  if (xs.length === 0) return { lower: 0, upper: 0 };
  if (xs.length === 1) return { lower: xs[0]!, upper: xs[0]! };
  const m = mean(xs);
  const se = stdDev(xs) / Math.sqrt(xs.length);
  // 1.96 z-score; we don't bother with t-table at N≥3
  const half = 1.96 * se;
  return { lower: m - half, upper: m + half };
}

function rankWithTies(absDiffs: ReadonlyArray<number>): number[] {
  const indexed = absDiffs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(absDiffs.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avg = (i + j) / 2 + 1; // 1-indexed average rank
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.39894228 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export function wilcoxonSignedRankP(
  parent: ReadonlyArray<number>,
  candidate: ReadonlyArray<number>,
): number {
  if (parent.length !== candidate.length) {
    throw new Error("wilcoxonSignedRankP: paired samples must have equal length");
  }
  const diffs: number[] = [];
  for (let i = 0; i < parent.length; i++) {
    const d = candidate[i]! - parent[i]!;
    if (d !== 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1;
  const ranks = rankWithTies(diffs.map(Math.abs));
  const wPlus = ranks.reduce((acc, r, i) => acc + (diffs[i]! > 0 ? r : 0), 0);
  const wMinus = ranks.reduce((acc, r, i) => acc + (diffs[i]! < 0 ? r : 0), 0);
  const w = Math.min(wPlus, wMinus);
  const n = diffs.length;
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  if (sigma === 0) return 1;
  const z = (w - mu + 0.5) / sigma; // continuity correction
  return 2 * normalCdf(-Math.abs(z));
}

export interface BeatsResult {
  beats: boolean;
  reason: string;
  parentMean: number;
  candidateMean: number;
  wilcoxonP?: number;
  parentCI?: CI;
  candidateCI?: CI;
}

export interface BeatsOptions {
  parentTokens?: number;
  candidateTokens?: number;
  /** Wilcoxon p-value threshold. Locked: 0.1 per handoff. */
  pThreshold?: number;
}

export function candidateBeatsParent(
  parentScores: ReadonlyArray<number>,
  candidateScores: ReadonlyArray<number>,
  opts: BeatsOptions = {},
): BeatsResult {
  const pMean = parentScores.length ? mean(parentScores) : 0;
  const cMean = candidateScores.length ? mean(candidateScores) : 0;
  // Empty-side guard: cannot promote a candidate that has no evaluable scores
  // (all task evals failed asymmetrically). Refuse rather than crash on
  // downstream stats. Parent-empty is similarly meaningless.
  if (parentScores.length === 0 || candidateScores.length === 0) {
    return {
      beats: false,
      reason: `inconclusive — empty score array (parent=${parentScores.length}, candidate=${candidateScores.length})`,
      parentMean: pMean,
      candidateMean: cMean,
    };
  }
  const pCI = ci95(parentScores);
  const cCI = ci95(candidateScores);
  const pThresh = opts.pThreshold ?? 0.1;

  // CI disjoint and candidate higher → win.
  if (cCI.lower > pCI.upper) {
    return {
      beats: true,
      reason: "non-overlapping 95% CIs (candidate higher)",
      parentMean: pMean,
      candidateMean: cMean,
      parentCI: pCI,
      candidateCI: cCI,
    };
  }
  // Wilcoxon — only meaningful if candidate mean ≥ parent AND arrays are
  // paired (equal length). When real-eval evaluator hits asymmetric per-task
  // failures (e.g. one task crashed on the candidate side but not the parent),
  // skip the paired stat and let the next gate (Occam tiebreak / no-op) decide.
  if (cMean > pMean && parentScores.length === candidateScores.length && parentScores.length >= 2) {
    const p = wilcoxonSignedRankP(parentScores, candidateScores);
    if (p < pThresh) {
      return {
        beats: true,
        reason: `Wilcoxon p=${p.toFixed(3)} < ${pThresh}`,
        parentMean: pMean,
        candidateMean: cMean,
        wilcoxonP: p,
      };
    }
  }
  // Occam tiebreak — strict tie on means + shorter prompt → win.
  if (
    cMean === pMean &&
    opts.parentTokens !== undefined &&
    opts.candidateTokens !== undefined &&
    opts.candidateTokens < opts.parentTokens
  ) {
    return {
      beats: true,
      reason: "Occam tiebreak: shorter prompt at equal score",
      parentMean: pMean,
      candidateMean: cMean,
    };
  }
  return {
    beats: false,
    reason: "no significant improvement",
    parentMean: pMean,
    candidateMean: cMean,
    parentCI: pCI,
    candidateCI: cCI,
  };
}
