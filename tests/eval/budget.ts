// Wave 2 F2.2 — three-layer budget cap, layer 2 (per-run).
// Per plan §6: maxCalls = 100, maxUsd = 5.00 default. Layer 1 (5-min
// per-experiment) lives in the autoresearch skill. Layer 3 is the z.ai
// account-level prepay cap (user-set).

export interface BudgetConfig {
  maxCalls: number;
  maxUsd: number;
  /** $ / 1k tokens. Default mirrors plan §6 rough GLM rate; refine after first run. */
  costPerKToken?: number;
}

export class BudgetExceededError extends Error {
  constructor(reason: string) {
    super(`Budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

const DEFAULT_COST_PER_K = 0.0005;

export interface BudgetStats {
  calls: number;
  estCostUsd: number;
}

export class BudgetGuard {
  private _calls = 0;
  private _estCost = 0;
  private readonly costPerK: number;

  constructor(private readonly config: BudgetConfig) {
    if (config.maxCalls <= 0) {
      throw new Error("BudgetGuard: maxCalls must be positive");
    }
    if (config.maxUsd <= 0) {
      throw new Error("BudgetGuard: maxUsd must be positive");
    }
    this.costPerK = config.costPerKToken ?? DEFAULT_COST_PER_K;
  }

  /** Record a planned worker call by its prompt length. Throws on cap. */
  guard(promptLen: number): void {
    if (promptLen < 0) {
      throw new Error("BudgetGuard.guard: promptLen must be >= 0");
    }
    this._calls += 1;
    if (this._calls > this.config.maxCalls) {
      throw new BudgetExceededError(
        `call cap ${this.config.maxCalls} (this would be call #${this._calls})`,
      );
    }
    this._estCost += (promptLen / 1000) * this.costPerK;
    if (this._estCost > this.config.maxUsd) {
      throw new BudgetExceededError(
        `USD cap $${this.config.maxUsd.toFixed(2)} (est now $${this._estCost.toFixed(4)})`,
      );
    }
  }

  get stats(): BudgetStats {
    return { calls: this._calls, estCostUsd: this._estCost };
  }
}
