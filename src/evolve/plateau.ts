// Wave 3 Step 2 — plateau-stop detector for the evolve loop.
//
// Locked rule: stop after `rounds` consecutive holdout observations
// that fail to improve by `minDelta`. Defaults: 5 rounds × 0.01 delta.
// Termination additionally requires `reSurvived` — an N=3 re-run on
// the best candidate must survive — so the runner gets a second
// sanity check before declaring done.

export const DEFAULT_PLATEAU_ROUNDS = 5;
export const DEFAULT_MIN_DELTA = 0.01;

export interface PlateauConfig {
  rounds?: number;
  minDelta?: number;
}

export class PlateauDetector {
  private readonly rounds: number;
  private readonly minDelta: number;
  private last: number | null = null;
  private flat = 0;

  constructor(cfg: PlateauConfig = {}) {
    this.rounds = cfg.rounds ?? DEFAULT_PLATEAU_ROUNDS;
    this.minDelta = cfg.minDelta ?? DEFAULT_MIN_DELTA;
  }

  observe(score: number): void {
    if (this.last === null) {
      this.last = score;
      this.flat = 0;
      return;
    }
    const delta = score - this.last;
    if (delta >= this.minDelta) {
      this.flat = 0;
    } else {
      this.flat += 1;
    }
    this.last = score;
  }

  get consecutiveFlatRounds(): number {
    return this.flat;
  }

  shouldStop(): boolean {
    return this.flat >= this.rounds;
  }

  /** Final gate — runner calls this with the N=3 re-run survival flag. */
  terminate(reSurvived: boolean): boolean {
    return this.shouldStop() && reSurvived;
  }
}
