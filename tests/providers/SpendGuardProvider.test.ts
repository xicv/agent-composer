import { describe, it, expect } from "vitest";
import {
  SpendGuardProvider,
  SpendLedger,
  SpendLimitError,
} from "../../src/providers/SpendGuardProvider.js";
import type { IProvider, IProviderExecuteInput, IProviderExecuteOutput } from "../../src/providers/IProvider.js";

/** Minimal fake inner provider with a call counter and configurable output. */
function fakeInner(
  output: IProviderExecuteOutput = { text: "ok", tokensIn: 1000, tokensOut: 1000 },
): IProvider & { callCount: number } {
  const fake = {
    id: "anthropic" as const,
    modelLabel: "glm-5.1",
    callCount: 0,
    async healthCheck(): Promise<boolean> {
      return true;
    },
    async execute(_input: IProviderExecuteInput): Promise<IProviderExecuteOutput> {
      fake.callCount++;
      return output;
    },
  };
  return fake;
}

describe("SpendGuardProvider — deny mode", () => {
  it("rejects every call and never invokes the inner provider", async () => {
    const inner = fakeInner();
    const ledger = new SpendLedger();
    const guard = new SpendGuardProvider(inner, { mode: "deny" }, ledger);

    await expect(guard.execute({ prompt: "hello" })).rejects.toThrow(SpendLimitError);
    await expect(guard.execute({ prompt: "hello" })).rejects.toThrow(/deny/);
    expect(inner.callCount).toBe(0);
  });
});

describe("SpendGuardProvider — auto mode, no caps", () => {
  it("passes through to inner provider and increments the ledger", async () => {
    const inner = fakeInner({ text: "ok", tokensIn: 1000, tokensOut: 1000 });
    const ledger = new SpendLedger();
    const guard = new SpendGuardProvider(inner, { mode: "auto" }, ledger);

    const result = await guard.execute({ prompt: "hello" });

    expect(result.text).toBe("ok");
    expect(inner.callCount).toBe(1);
    // glm-5.1 price: 0.6/MTok in + 2.2/MTok out
    // 1000 in + 1000 out → (0.6 + 2.2) / 1000 = 0.0028
    expect(ledger.spentUsd).toBeGreaterThan(0);
  });

  it("delegates id and modelLabel from the inner provider", () => {
    const inner = fakeInner();
    const guard = new SpendGuardProvider(inner, { mode: "auto" }, new SpendLedger());
    expect(guard.id).toBe("anthropic");
    expect(guard.modelLabel).toBe("glm-5.1");
  });

  it("delegates healthCheck to the inner provider", async () => {
    const inner = fakeInner();
    const guard = new SpendGuardProvider(inner, { mode: "auto" }, new SpendLedger());
    await expect(guard.healthCheck()).resolves.toBe(true);
  });
});

describe("SpendGuardProvider — auto mode, maxUsdPerCall", () => {
  it("blocks when estimated call cost exceeds maxUsdPerCall and does not call inner", async () => {
    const inner = fakeInner();
    const ledger = new SpendLedger();
    // Cap is 0.0000001 — even a tiny prompt with default output tokens will exceed this
    const guard = new SpendGuardProvider(
      inner,
      { mode: "auto", maxUsdPerCall: 0.0000001 },
      ledger,
    );

    await expect(guard.execute({ prompt: "hello" })).rejects.toMatchObject({
      name: "SpendLimitError",
      kind: "spend_cap_call",
    });
    await expect(guard.execute({ prompt: "hello" })).rejects.toThrow(/maxUsdPerCall/);
    expect(inner.callCount).toBe(0);
  });

  it("allows a call when the estimate is within maxUsdPerCall", async () => {
    const inner = fakeInner({ text: "ok", tokensIn: 10, tokensOut: 10 });
    const ledger = new SpendLedger();
    // A very generous cap: $1 per call
    const guard = new SpendGuardProvider(
      inner,
      { mode: "auto", maxUsdPerCall: 1 },
      ledger,
    );

    await expect(guard.execute({ prompt: "hi", maxTokens: 10 })).resolves.toMatchObject({ text: "ok" });
    expect(inner.callCount).toBe(1);
  });
});

describe("SpendGuardProvider — auto mode, maxUsdPerSession", () => {
  it("first call succeeds; second call fails when session cap is exhausted", async () => {
    // Use a large prompt so the per-call cost is significant, and a cap that
    // allows exactly one call. glm-5.1 pricing: 0.6/MTok in + 2.2/MTok out.
    // A 4000-char prompt → ~1000 tokens in. maxTokens=4096 → est cost ≈ 0.009652 USD.
    // Set cap to 0.01 (allows the first call: 0 + 0.009652 < 0.01) but not the second.
    const prompt = "x".repeat(4000);
    const inner = fakeInner({ text: "ok", tokensIn: 1000, tokensOut: 4096 });
    const ledger = new SpendLedger();
    const guard = new SpendGuardProvider(
      inner,
      { mode: "auto", maxUsdPerSession: 0.01 },
      ledger,
    );

    // First call: ledger starts at 0, estimated cost ≈ 0.009652 < 0.01 → allowed
    const first = await guard.execute({ prompt, maxTokens: 4096 });
    expect(first.text).toBe("ok");
    expect(inner.callCount).toBe(1);

    // After first call ledger ≈ 0.009652. Second call estimate would push it > 0.01
    await expect(guard.execute({ prompt, maxTokens: 4096 })).rejects.toMatchObject({
      name: "SpendLimitError",
      kind: "spend_cap_session",
    });
    await expect(guard.execute({ prompt, maxTokens: 4096 })).rejects.toThrow(/maxUsdPerSession/);
    // inner was not called again for the rejected attempts
    expect(inner.callCount).toBe(1);
  });
});

describe("SpendGuardProvider — pricing by model", () => {
  it("opus model produces a larger ledger increment than glm for identical token counts", async () => {
    const tokens: IProviderExecuteOutput = { text: "ok", tokensIn: 1000, tokensOut: 1000 };

    // GLM guard
    const glmInner: IProvider = {
      id: "anthropic",
      modelLabel: "glm-5.1",
      healthCheck: async () => true,
      execute: async () => tokens,
    };
    const glmLedger = new SpendLedger();
    const glmGuard = new SpendGuardProvider(glmInner, { mode: "auto" }, glmLedger);

    // Opus guard
    const opusInner: IProvider = {
      id: "anthropic",
      modelLabel: "claude-opus-4",
      healthCheck: async () => true,
      execute: async () => tokens,
    };
    const opusLedger = new SpendLedger();
    const opusGuard = new SpendGuardProvider(opusInner, { mode: "auto" }, opusLedger);

    await glmGuard.execute({ prompt: "test" });
    await opusGuard.execute({ prompt: "test" });

    expect(opusLedger.spentUsd).toBeGreaterThan(glmLedger.spentUsd);
  });
});

describe("SpendGuardProvider — defaultMaxTokens parameter", () => {
  it("uses defaultMaxTokens estimate when input.maxTokens is absent and blocks a cap that 4096 would pass", async () => {
    // glm-5.1 pricing: 0.6/MTok in + 2.2/MTok out
    // With DEFAULT_MAX_OUTPUT_TOKENS=4096:  cost = (4096/1e6)*2.2 ≈ $0.0090
    // With defaultMaxTokens=200000:         cost = (200000/1e6)*2.2 ≈ $0.44
    // Cap $0.05 → passes with 4096 estimate ($0.009 < $0.05), fails with 200000 estimate ($0.44 > $0.05)
    const inner = fakeInner({ text: "ok" }); // no tokensOut reported — estimate is used
    const ledger = new SpendLedger();
    const guard = new SpendGuardProvider(
      inner,
      { mode: "auto", maxUsdPerCall: 0.05 },
      ledger,
      200000,
    );

    // No input.maxTokens — should use defaultMaxTokens (200000), which exceeds the cap
    await expect(guard.execute({ prompt: "" })).rejects.toThrow(SpendLimitError);
    await expect(guard.execute({ prompt: "" })).rejects.toThrow(/maxUsdPerCall/);
    expect(inner.callCount).toBe(0);
  });

  it("control: same cap passes when defaultMaxTokens is undefined (falls back to 4096 estimate)", async () => {
    const inner = fakeInner({ text: "ok" }); // no tokensOut reported
    const ledger = new SpendLedger();
    // No defaultMaxTokens — falls back to DEFAULT_MAX_OUTPUT_TOKENS=4096
    const guard = new SpendGuardProvider(
      inner,
      { mode: "auto", maxUsdPerCall: 0.05 },
      ledger,
      undefined,
    );

    // 4096-token estimate ≈ $0.009 < $0.05 → allowed
    await expect(guard.execute({ prompt: "" })).resolves.toMatchObject({ text: "ok" });
    expect(inner.callCount).toBe(1);
  });
});

describe("SpendLedger", () => {
  it("starts at zero", () => {
    expect(new SpendLedger().spentUsd).toBe(0);
  });

  it("accumulates positive finite values", () => {
    const l = new SpendLedger();
    l.add(0.01);
    l.add(0.02);
    expect(l.spentUsd).toBeCloseTo(0.03);
  });

  it("ignores non-positive or non-finite values", () => {
    const l = new SpendLedger();
    l.add(0);
    l.add(-1);
    l.add(NaN);
    l.add(Infinity);
    expect(l.spentUsd).toBe(0);
  });
});
