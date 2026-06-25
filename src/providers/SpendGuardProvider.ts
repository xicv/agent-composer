import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
  ProviderId,
} from "./IProvider.js";
import type { SpendAuthorization } from "../config/schema.js";

/** Thrown when a priced call is blocked by spendAuthorization (deny mode or a cap). */
export class SpendLimitError extends Error {
  constructor(
    message: string,
    readonly kind: "spend_denied" | "spend_cap_call" | "spend_cap_session" = "spend_denied",
  ) {
    super(message);
    this.name = "SpendLimitError";
  }
}

/** Mutable, registry-scoped accumulator of estimated USD spend for the session. */
export class SpendLedger {
  #spentUsd = 0;
  get spentUsd(): number {
    return this.#spentUsd;
  }
  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.#spentUsd += usd;
  }
}

interface Price {
  inPerMTok: number;
  outPerMTok: number;
}

// Rough public list prices (USD per 1M tokens). Estimates only — the guard is a
// conservative ceiling, not an accountant. Unknown models fall back to a
// deliberately high default so an unrecognized model is more likely to trip a
// cap than to silently overspend.
const PRICE_TABLE: ReadonlyArray<{ match: RegExp; price: Price }> = [
  { match: /glm/i, price: { inPerMTok: 0.6, outPerMTok: 2.2 } },
  { match: /haiku/i, price: { inPerMTok: 1, outPerMTok: 5 } },
  { match: /sonnet/i, price: { inPerMTok: 3, outPerMTok: 15 } },
  { match: /opus/i, price: { inPerMTok: 15, outPerMTok: 75 } },
];
const DEFAULT_PRICE: Price = { inPerMTok: 3, outPerMTok: 15 };

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function priceFor(model: string): Price {
  for (const entry of PRICE_TABLE) {
    if (entry.match.test(model)) return entry.price;
  }
  return DEFAULT_PRICE;
}

function estimateUsd(model: string, tokensIn: number, tokensOut: number): number {
  const price = priceFor(model);
  return (tokensIn / 1_000_000) * price.inPerMTok + (tokensOut / 1_000_000) * price.outPerMTok;
}

/**
 * Decorator that enforces spendAuthorization on a priced inner provider.
 * - mode "deny": blocks every call.
 * - maxUsdPerCall: blocks if the worst-case (maxTokens) estimate exceeds the cap.
 * - maxUsdPerSession: blocks if the running ledger + this call's estimate exceeds the cap.
 * After a successful call, the ledger is incremented by the ACTUAL token cost
 * (from the provider's reported usage) when available, else the estimate.
 */
export class SpendGuardProvider implements IProvider {
  readonly id: ProviderId;
  readonly modelLabel: string;

  constructor(
    private readonly inner: IProvider,
    private readonly auth: SpendAuthorization,
    private readonly ledger: SpendLedger,
    private readonly defaultMaxTokens?: number,
  ) {
    this.id = inner.id;
    this.modelLabel = inner.modelLabel;
  }

  healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput> {
    if (this.auth.mode === "deny") {
      throw new SpendLimitError(
        `Priced provider '${this.modelLabel}' blocked: spendAuthorization.mode="deny".`,
      );
    }

    const inputChars = (input.prompt?.length ?? 0) + (input.context?.length ?? 0);
    const estTokensIn = Math.ceil(inputChars / CHARS_PER_TOKEN);
    const estTokensOut =
      typeof input.maxTokens === "number" && input.maxTokens > 0
        ? input.maxTokens
        : typeof this.defaultMaxTokens === "number" && this.defaultMaxTokens > 0
          ? this.defaultMaxTokens
          : DEFAULT_MAX_OUTPUT_TOKENS;
    const estCallUsd = estimateUsd(this.modelLabel, estTokensIn, estTokensOut);

    if (this.auth.maxUsdPerCall !== undefined && estCallUsd > this.auth.maxUsdPerCall) {
      throw new SpendLimitError(
        `Estimated $${estCallUsd.toFixed(4)} for this '${this.modelLabel}' call exceeds maxUsdPerCall $${this.auth.maxUsdPerCall}.`,
        "spend_cap_call",
      );
    }
    if (
      this.auth.maxUsdPerSession !== undefined &&
      this.ledger.spentUsd + estCallUsd > this.auth.maxUsdPerSession
    ) {
      throw new SpendLimitError(
        `Estimated session spend $${(this.ledger.spentUsd + estCallUsd).toFixed(4)} would exceed maxUsdPerSession $${this.auth.maxUsdPerSession} (already $${this.ledger.spentUsd.toFixed(4)}).`,
        "spend_cap_session",
      );
    }

    const output = await this.inner.execute(input);

    const actualTokensIn = output.tokensIn ?? estTokensIn;
    const actualTokensOut = output.tokensOut ?? estTokensOut;
    this.ledger.add(estimateUsd(this.modelLabel, actualTokensIn, actualTokensOut));

    return output;
  }
}

export function isPricedProvider(id: ProviderId): boolean {
  return id === "anthropic";
}
