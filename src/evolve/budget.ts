// Wave 3 Step 2 — per-/evolve-session BudgetGuard.
//
// Distinct from the Wave 2 per-eval BudgetGuard (tests/eval/budget.ts):
// that one caps a single eval run; this one caps the whole evolve loop
// (~100 eval calls + ~30 reflection calls ≈ $3.50, capped at $4.00).
//
// Reflection LM is GLM 5.1: $0.98 in / $3.08 out per MTok.

export interface EvolveBudgetConfig {
  maxCalls: number;
  maxUsd: number;
}

export const DEFAULT_EVOLVE_BUDGET: EvolveBudgetConfig = {
  maxCalls: 100,
  maxUsd: 4.0,
};

export class EvolveBudgetExceededError extends Error {
  constructor(reason: string) {
    super(`Evolve budget exceeded: ${reason}`);
    this.name = "EvolveBudgetExceededError";
  }
}

export interface EvolveBudgetStats {
  calls: number;
  usd: number;
}

export class EvolveBudgetGuard {
  private _calls = 0;
  private _usd = 0;

  constructor(private readonly config: EvolveBudgetConfig) {
    if (config.maxCalls <= 0) throw new Error("EvolveBudgetGuard: maxCalls must be positive");
    if (config.maxUsd <= 0) throw new Error("EvolveBudgetGuard: maxUsd must be positive");
  }

  /** Record a completed call and its measured USD cost. Throws on cap. */
  spent(usdCost: number): void {
    if (usdCost < 0) throw new Error("EvolveBudgetGuard.spent: usdCost must be >= 0");
    this._calls += 1;
    if (this._calls > this.config.maxCalls) {
      throw new EvolveBudgetExceededError(
        `call cap ${this.config.maxCalls} (this would be call #${this._calls})`,
      );
    }
    this._usd += usdCost;
    if (this._usd > this.config.maxUsd) {
      throw new EvolveBudgetExceededError(
        `USD cap $${this.config.maxUsd.toFixed(2)} (now $${this._usd.toFixed(4)})`,
      );
    }
  }

  get stats(): EvolveBudgetStats {
    return { calls: this._calls, usd: this._usd };
  }

  get remaining(): EvolveBudgetStats {
    return {
      calls: this.config.maxCalls - this._calls,
      usd: this.config.maxUsd - this._usd,
    };
  }

  exhausted(): boolean {
    return this._calls >= this.config.maxCalls || this._usd >= this.config.maxUsd;
  }
}
