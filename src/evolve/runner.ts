// Wave 3 Step 2 — evolve loop orchestrator.
//
// Wires the rest of src/evolve/* into a single `runEvolve` call:
//   preflight → for each round:
//                 - pick task split (train+val / holdout rotation)
//                 - pick operator (round-robin)
//                 - mutate via operator (reflect_and_rewrite uses reflectionProvider)
//                 - evaluate on train+val
//                 - candidateBeatsParent? if yes, N=re-run, promote if survives
//                 - lengthPenalty applied to score
//                 - plateau detector observes holdout score
//               → on plateau or budget or maxRounds, exit
//   postflight on winner → if reject, revert to parent
//
// All worker calls accounted in EvolveBudgetGuard. Provider-side costs
// are estimated per-call (default $0.025 per eval call, matches plan).

import { pickOperator, type OperatorContext } from "./operators.js";
import { lengthPenalty, estimateTokens } from "./lengthPenalty.js";
import { candidateBeatsParent } from "./pareto.js";
import { PlateauDetector } from "./plateau.js";
import {
  EvolveBudgetGuard,
  EvolveBudgetExceededError,
  DEFAULT_EVOLVE_BUDGET,
  type EvolveBudgetConfig,
} from "./budget.js";
import { runPreflight, type PreflightSnapshot } from "./preflight.js";
import { runPostflight, type Verdict } from "./postflight.js";
import { reflectViaProvider } from "./reflection.js";
import type { IProvider } from "../providers/IProvider.js";
import type { TaskTranscript } from "./reflection.js";

export interface EvolveTask {
  id: string;
  description: string;
}

export interface EvalResult {
  score: number;
  transcripts: ReadonlyArray<TaskTranscript>;
}

export interface EvolveDeps {
  reflectionProvider: IProvider;
  researchProvider: IProvider;
  evaluate: (skill: string, tasks: ReadonlyArray<EvolveTask>) => Promise<EvalResult>;
  reReplicate: (skill: string, tasks: ReadonlyArray<EvolveTask>) => Promise<boolean>;
  skillDomain: string;
  lastEvolveDate?: string;
  /** Override postflight provider call entirely (test hook). */
  postflightOverride?: (winner: string, snap: PreflightSnapshot) => Promise<Verdict>;
  /** Estimated USD cost per worker call. */
  costPerCallUsd?: number;
}

export interface EvolveOptions {
  parent: string;
  tasks: ReadonlyArray<EvolveTask>;
  deps: EvolveDeps;
  maxRounds?: number;
  reRunSamples?: number;
  budget?: EvolveBudgetConfig;
  lengthLambda?: number;
}

export interface EvolveRoundLog {
  round: number;
  operator: string;
  parentScore: number;
  candidateScore: number;
  promoted: boolean;
  reason: string;
}

export interface EvolveResult {
  winner: string;
  history: EvolveRoundLog[];
  stoppedAt: "plateau" | "budget" | "maxRounds";
  preflight?: PreflightSnapshot;
  postflight?: Verdict;
  postflightRejections: Verdict[];
  budgetStats: { calls: number; usd: number };
}

export function rotateHoldout(
  tasks: ReadonlyArray<EvolveTask>,
  round: number,
): { holdout: EvolveTask; trainVal: EvolveTask[] } {
  if (tasks.length < 2) {
    throw new Error("rotateHoldout: need at least 2 tasks");
  }
  const idx = round % tasks.length;
  const holdout = tasks[idx]!;
  const trainVal = tasks.filter((_, i) => i !== idx);
  return { holdout, trainVal };
}

const DEFAULT_COST_PER_CALL = 0.025;

export async function runEvolve(opts: EvolveOptions): Promise<EvolveResult> {
  const {
    parent,
    tasks,
    deps,
    maxRounds = 30,
    reRunSamples = 3,
    budget = DEFAULT_EVOLVE_BUDGET,
    lengthLambda,
  } = opts;

  const guard = new EvolveBudgetGuard(budget);
  const plateau = new PlateauDetector();
  const costPerCall = deps.costPerCallUsd ?? DEFAULT_COST_PER_CALL;
  const charge = () => guard.spent(costPerCall);

  const preflight = await runPreflight(deps.researchProvider, {
    skillDomain: deps.skillDomain,
    lastEvolveDate: deps.lastEvolveDate,
  });
  try {
    charge();
  } catch (e) {
    if (e instanceof EvolveBudgetExceededError) {
      return {
        winner: parent,
        history: [],
        stoppedAt: "budget",
        preflight,
        postflightRejections: [],
        budgetStats: guard.stats,
      };
    }
    throw e;
  }

  let winner = parent;
  const history: EvolveRoundLog[] = [];
  const rejections: Verdict[] = [];
  let stoppedAt: EvolveResult["stoppedAt"] = "maxRounds";

  for (let round = 0; round < maxRounds; round++) {
    const split = rotateHoldout(tasks, round);
    const op = pickOperator(round);
    const ctx: OperatorContext = {
      currentEcosystem: preflight.text,
      reflect: (text) =>
        reflectViaProvider(deps.reflectionProvider, {
          parent: text,
          taskTranscripts: [],
          currentEcosystem: preflight.text,
        }),
    };

    let candidate: string;
    try {
      candidate = await op.apply(winner, ctx);
      charge();
    } catch (e) {
      if (e instanceof EvolveBudgetExceededError) {
        stoppedAt = "budget";
        break;
      }
      throw e;
    }

    const parentEval = await deps.evaluate(winner, split.trainVal);
    try { charge(); } catch (e) {
      if (e instanceof EvolveBudgetExceededError) { stoppedAt = "budget"; break; }
      throw e;
    }
    const candEval = await deps.evaluate(candidate, split.trainVal);
    try { charge(); } catch (e) {
      if (e instanceof EvolveBudgetExceededError) { stoppedAt = "budget"; break; }
      throw e;
    }

    const pAdj = parentEval.score + lengthPenalty(winner, lengthLambda);
    const cAdj = candEval.score + lengthPenalty(candidate, lengthLambda);

    const beats = candidateBeatsParent([pAdj], [cAdj], {
      parentTokens: estimateTokens(winner),
      candidateTokens: estimateTokens(candidate),
    });

    let promoted = false;
    let reason = beats.reason;
    if (beats.beats) {
      // N re-run survival
      const survives: number[] = [];
      let budgetBroke = false;
      for (let n = 0; n < reRunSamples; n++) {
        const r = await deps.evaluate(candidate, split.trainVal);
        survives.push(r.score + lengthPenalty(candidate, lengthLambda));
        try { charge(); } catch (e) {
          if (e instanceof EvolveBudgetExceededError) { stoppedAt = "budget"; budgetBroke = true; break; }
          throw e;
        }
      }
      if (budgetBroke) break;
      const surviveBeats = candidateBeatsParent([pAdj], survives, {
        parentTokens: estimateTokens(winner),
        candidateTokens: estimateTokens(candidate),
      });
      if (surviveBeats.beats) {
        winner = candidate;
        promoted = true;
        reason = `${beats.reason}; re-run ${surviveBeats.reason}`;
      } else {
        reason = `beat parent once but failed re-run (${surviveBeats.reason})`;
      }
    }

    // Holdout observation drives plateau
    const holdoutResult = await deps.evaluate(winner, [split.holdout]);
    try { charge(); } catch (e) {
      if (e instanceof EvolveBudgetExceededError) { stoppedAt = "budget"; break; }
      throw e;
    }
    plateau.observe(holdoutResult.score + lengthPenalty(winner, lengthLambda));

    history.push({
      round,
      operator: op.name,
      parentScore: pAdj,
      candidateScore: cAdj,
      promoted,
      reason,
    });

    if (plateau.shouldStop()) {
      const survived = await deps.reReplicate(winner, [split.holdout]);
      if (plateau.terminate(survived)) {
        stoppedAt = "plateau";
        break;
      }
    }
  }

  const postflight = deps.postflightOverride
    ? await deps.postflightOverride(winner, preflight)
    : await runPostflight(deps.researchProvider, {
        ecosystem: preflight.text,
        candidate: winner,
      });

  let finalWinner = winner;
  if (!postflight.accept) {
    rejections.push(postflight);
    finalWinner = parent;
  }

  return {
    winner: finalWinner,
    history,
    stoppedAt,
    preflight,
    postflight,
    postflightRejections: rejections,
    budgetStats: guard.stats,
  };
}
