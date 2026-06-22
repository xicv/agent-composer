import { describe, expect, it } from "vitest";

import {
  DispatchUnavailableError,
  classifyDispatchError,
  dispatchWithFallback,
} from "../../src/server/dispatchWithFallback.js";
import { SpendLimitError } from "../../src/providers/SpendGuardProvider.js";
import type { RoleName } from "../../src/config/schema.js";
import type {
  IProvider,
  IProviderExecuteInput,
  IProviderExecuteOutput,
} from "../../src/providers/IProvider.js";

class ScriptedProvider implements IProvider {
  readonly id = "mock" as const;
  readonly modelLabel: string;
  readonly calls: IProviderExecuteInput[] = [];

  constructor(
    modelLabel: string,
    private readonly behavior: (input: IProviderExecuteInput) => IProviderExecuteOutput | never,
  ) {
    this.modelLabel = modelLabel;
  }

  async healthCheck(): Promise<boolean> {
    throw new Error("healthCheck must not be used by dispatchWithFallback");
  }

  async execute(input: IProviderExecuteInput): Promise<IProviderExecuteOutput> {
    this.calls.push(input);
    return this.behavior(input);
  }
}

function registry(providers: Partial<Record<RoleName, IProvider>>) {
  return {
    getProviderForRole(role: RoleName): IProvider {
      const provider = providers[role];
      if (!provider) throw new Error(`missing provider ${role}`);
      return provider;
    },
  };
}

describe("classifyDispatchError", () => {
  it("classifies every bounded dispatch error class", () => {
    expect(classifyDispatchError(new Error("503 temporarily unavailable"), "mock")).toBe("UNAVAILABLE");
    expect(classifyDispatchError(new Error("request timed out"), "mock")).toBe("TIMEOUT");
    expect(classifyDispatchError(new Error("429 rate limit exceeded"), "mock")).toBe("RATE_LIMIT");
    expect(classifyDispatchError(new SpendLimitError("call cap", "spend_cap_call"), "mock")).toBe("SPEND_CAP_CALL");
    expect(classifyDispatchError(new SpendLimitError("session cap", "spend_cap_session"), "mock")).toBe("SPEND_CAP_SESSION");
    expect(classifyDispatchError(new Error("401 authentication_error invalid api key"), "mock")).toBe("AUTH");
    expect(classifyDispatchError(new Error("schema validation failed"), "mock")).toBe("VALIDATION");
  });
});

describe("dispatchWithFallback", () => {
  it("falls back for read-only roles and returns the successful provider role", async () => {
    const researcher = new ScriptedProvider("primary", () => {
      throw new Error("503 unavailable");
    });
    const reviewer = new ScriptedProvider("fallback", () => ({ text: "fallback ok" }));

    const result = await dispatchWithFallback(
      {
        registry: registry({ researcher, reviewer }),
        effectiveFallbacks: { researcher: ["reviewer"] },
      },
      "researcher",
      { prompt: "research" },
    );

    expect(result.output.text).toBe("fallback ok");
    expect(result.summary).toMatchObject({
      primaryRole: "researcher",
      providerRole: "reviewer",
      fallbackUsed: true,
      attempts: [{ role: "researcher", providerId: "mock", errorClass: "UNAVAILABLE" }],
    });
    expect(researcher.calls).toHaveLength(1);
    expect(reviewer.calls).toHaveLength(1);
  });

  it("treats per-call spend caps as skippable and per-session caps as terminal", async () => {
    const researcher = new ScriptedProvider("primary", () => {
      throw new SpendLimitError("call cap", "spend_cap_call");
    });
    const reviewer = new ScriptedProvider("fallback", () => ({ text: "fallback ok" }));

    await expect(
      dispatchWithFallback(
        {
          registry: registry({ researcher, reviewer }),
          effectiveFallbacks: { researcher: ["reviewer"] },
        },
        "researcher",
        { prompt: "research" },
      ),
    ).resolves.toMatchObject({
      output: { text: "fallback ok" },
      summary: { attempts: [{ errorClass: "SPEND_CAP_CALL" }] },
    });

    const sessionCapped = new ScriptedProvider("primary", () => {
      throw new SpendLimitError("session cap", "spend_cap_session");
    });
    await expect(
      dispatchWithFallback(
        {
          registry: registry({ researcher: sessionCapped, reviewer }),
          effectiveFallbacks: { researcher: ["reviewer"] },
        },
        "researcher",
        { prompt: "research" },
      ),
    ).rejects.toMatchObject({
      attempts: [{ role: "researcher", providerId: "mock", errorClass: "SPEND_CAP_SESSION" }],
    });
  });

  it("continues on auth/config errors and throws Unavailable with attempts when exhausted", async () => {
    const researcher = new ScriptedProvider("primary", () => {
      throw new Error("not authenticated; please login");
    });
    const reviewer = new ScriptedProvider("fallback", () => {
      throw new Error("429 rate limit exceeded");
    });

    await expect(
      dispatchWithFallback(
        {
          registry: registry({ researcher, reviewer }),
          effectiveFallbacks: { researcher: ["reviewer"] },
        },
        "researcher",
        { prompt: "research" },
      ),
    ).rejects.toMatchObject({
      name: "DispatchUnavailableError",
      attempts: [
        { role: "researcher", errorClass: "AUTH" },
        { role: "reviewer", errorClass: "RATE_LIMIT" },
      ],
    });
  });

  it("degrades to a single attempt when no fallback is configured", async () => {
    const reviewer = new ScriptedProvider("only", () => ({ text: "single ok" }));

    const result = await dispatchWithFallback(
      { registry: registry({ reviewer }), effectiveFallbacks: {} },
      "reviewer",
      { prompt: "review" },
    );

    expect(result.summary).toEqual({
      primaryRole: "reviewer",
      providerRole: "reviewer",
      fallbackUsed: false,
      attempts: [],
    });
    expect(reviewer.calls).toHaveLength(1);
  });

  it("does not enable runtime fallback for mutating roles", async () => {
    const coder = new ScriptedProvider("coder", () => {
      throw new Error("503 unavailable");
    });
    const coderCli = new ScriptedProvider("coderCli", () => ({ text: "must not run" }));

    await expect(
      dispatchWithFallback(
        {
          registry: registry({ coder, coderCli }),
          effectiveFallbacks: { coder: ["coderCli"] },
        },
        "coder",
        { prompt: "mutate" },
      ),
    ).rejects.toThrow("503 unavailable");
    expect(coder.calls).toHaveLength(1);
    expect(coderCli.calls).toHaveLength(0);
  });
});
