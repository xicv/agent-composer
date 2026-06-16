import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ProviderRegistry,
  ProviderNotImplementedError,
  ProviderConfigError,
} from "../src/registry.js";
import { MockProvider } from "../src/providers/MockProvider.js";
import { AnthropicCompatibleProvider } from "../src/providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "../src/providers/CLIProvider.js";
import { SpendGuardProvider } from "../src/providers/SpendGuardProvider.js";
import { parseConfig } from "../src/config/loader.js";
import type { ComposerConfig } from "../src/config/schema.js";

function makeConfig(
  coder: Record<string, unknown>,
): ComposerConfig {
  return parseConfig({
    roles: {
      researcher: { provider: "mock" },
      coder,
      reviewer: { provider: "mock" },
    },
  });
}

describe("ProviderRegistry — mock", () => {
  it("returns a MockProvider when role.provider === 'mock'", () => {
    const reg = new ProviderRegistry(makeConfig({ provider: "mock" }));
    expect(reg.getProviderForRole("coder")).toBeInstanceOf(MockProvider);
  });

  it("caches provider instance per role (same object returned)", () => {
    const reg = new ProviderRegistry(makeConfig({ provider: "mock" }));
    const a = reg.getProviderForRole("coder");
    const b = reg.getProviderForRole("coder");
    expect(a).toBe(b);
  });

  it("forwards role.model to MockProvider.modelLabel", () => {
    const reg = new ProviderRegistry(
      makeConfig({ provider: "mock", model: "custom-test-model" }),
    );
    const p = reg.getProviderForRole("coder") as MockProvider;
    expect(p.modelLabel).toBe("custom-test-model");
  });
});

describe("ProviderRegistry — anthropic (Day 2)", () => {
  const stashedEnv = process.env["TEST_ANTHROPIC_KEY"];
  beforeEach(() => {
    process.env["TEST_ANTHROPIC_KEY"] = "test-glm-key";
  });
  afterEach(() => {
    if (stashedEnv === undefined) delete process.env["TEST_ANTHROPIC_KEY"];
    else process.env["TEST_ANTHROPIC_KEY"] = stashedEnv;
  });

  it("builds AnthropicCompatibleProvider when env var set", () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnv: "TEST_ANTHROPIC_KEY",
        model: "glm-4.6",
      }),
    );
    const p = reg.getProviderForRole("coder");
    expect(p).toBeInstanceOf(AnthropicCompatibleProvider);
    expect(p.id).toBe("anthropic");
    expect(p.modelLabel).toBe("glm-4.6");
  });

  it("throws ProviderConfigError when apiKeyEnv not set in environment", () => {
    delete process.env["TEST_ANTHROPIC_KEY"];
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        baseUrl: "https://x",
        apiKeyEnv: "TEST_ANTHROPIC_KEY",
        model: "glm-4.6",
      }),
    );
    expect(() => reg.getProviderForRole("coder")).toThrow(ProviderConfigError);
  });

  it("throws ProviderConfigError when baseUrl missing", () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        apiKeyEnv: "TEST_ANTHROPIC_KEY",
        model: "glm-4.6",
      }),
    );
    expect(() => reg.getProviderForRole("coder")).toThrow(/baseUrl/);
  });

  it("throws ProviderConfigError when apiKeyEnv missing from config", () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        baseUrl: "https://x",
        model: "glm-4.6",
      }),
    );
    expect(() => reg.getProviderForRole("coder")).toThrow(/apiKeyEnv/);
  });

});

describe("ProviderRegistry — anthropic model precedence (Step 4)", () => {
  const stashKey = process.env["TEST_ANTHROPIC_KEY"];
  const stashModel = process.env["ANTHROPIC_MODEL"];
  beforeEach(() => {
    process.env["TEST_ANTHROPIC_KEY"] = "test-glm-key";
    delete process.env["ANTHROPIC_MODEL"];
  });
  afterEach(() => {
    if (stashKey === undefined) delete process.env["TEST_ANTHROPIC_KEY"];
    else process.env["TEST_ANTHROPIC_KEY"] = stashKey;
    if (stashModel === undefined) delete process.env["ANTHROPIC_MODEL"];
    else process.env["ANTHROPIC_MODEL"] = stashModel;
  });

  function anthropic(model?: string) {
    return new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        baseUrl: "https://x",
        apiKeyEnv: "TEST_ANTHROPIC_KEY",
        ...(model !== undefined ? { model } : {}),
      }),
    );
  }

  it("ANTHROPIC_MODEL env var WINS over role.model in config", () => {
    process.env["ANTHROPIC_MODEL"] = "glm-5.1";
    const p = anthropic("glm-4.6").getProviderForRole("coder");
    expect(p.modelLabel).toBe("glm-5.1");
  });

  it("falls back to role.model when env not set", () => {
    const p = anthropic("glm-4.6").getProviderForRole("coder");
    expect(p.modelLabel).toBe("glm-4.6");
  });

  it("defaults to glm-5.2 when neither env nor config provide a model", () => {
    const p = anthropic(undefined).getProviderForRole("coder");
    expect(p.modelLabel).toBe("glm-5.2");
  });

  it("treats empty env var as unset", () => {
    process.env["ANTHROPIC_MODEL"] = "";
    const p = anthropic("glm-4.6").getProviderForRole("coder");
    expect(p.modelLabel).toBe("glm-4.6");
  });
});

describe("ProviderRegistry — cli (Day 2)", () => {
  it("builds CLIProvider when cli argv set", () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "cli",
        cli: ["agy", "--dangerously-skip-permissions", "-p"],
      }),
    );
    const p = reg.getProviderForRole("coder");
    expect(p).toBeInstanceOf(CLIProvider);
    expect(p.id).toBe("cli");
  });

  it("forwards CLI execution controls to CLIProvider", async () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "cli",
        cli: ["node", "-e", "process.stdout.write('x'.repeat(200))"],
        timeoutMs: 1000,
        retries: 0,
        maxResultChars: 40,
      }),
    );
    const out = await reg.getProviderForRole("coder").execute({ prompt: "ignored" });
    expect(out.text).toContain("[elided ");
  });

  it("throws ProviderConfigError when cli argv missing (schema reject would also catch)", () => {
    // Bypass schema validation to test the registry's own guard.
    const cfg = {
      roles: {
        researcher: { provider: "mock" as const },
        coder: { provider: "cli" as const },
        reviewer: { provider: "mock" as const },
      },
    } as ComposerConfig;
    const reg = new ProviderRegistry(cfg);
    expect(() => reg.getProviderForRole("coder")).toThrow(ProviderConfigError);
  });
});

describe("ProviderRegistry — config reload", () => {
  it("setConfig replaces role config and clears cached providers", () => {
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "cli",
        cli: ["node", "-e", "setTimeout(() => {}, 1000)"],
        timeoutMs: 1000,
      }),
    );
    const before = reg.getProviderForRole("coder");

    reg.setConfig(
      makeConfig({
        provider: "cli",
        cli: ["node", "-e", "setTimeout(() => {}, 1000)"],
        timeoutMs: 10,
      }),
    );

    const after = reg.getProviderForRole("coder");
    expect(after).toBeInstanceOf(CLIProvider);
    expect(after).not.toBe(before);
  });
});

describe("ProviderRegistry — openai_compatible (still YAGNI)", () => {
  it("throws ProviderNotImplementedError", () => {
    const reg = new ProviderRegistry(
      makeConfig({ provider: "openai_compatible", baseUrl: "https://x" }),
    );
    expect(() => reg.getProviderForRole("coder")).toThrow(
      ProviderNotImplementedError,
    );
  });
});

describe("ProviderRegistry — multi-role resolution", () => {
  it("resolves all three roles independently with their own provider instances", () => {
    const reg = new ProviderRegistry(
      parseConfig({
        roles: {
          researcher: { provider: "mock", model: "r-mock" },
          coder: { provider: "mock", model: "c-mock" },
          reviewer: { provider: "mock", model: "v-mock" },
        },
      }),
    );
    expect((reg.getProviderForRole("researcher") as MockProvider).modelLabel).toBe(
      "r-mock",
    );
    expect((reg.getProviderForRole("coder") as MockProvider).modelLabel).toBe(
      "c-mock",
    );
    expect((reg.getProviderForRole("reviewer") as MockProvider).modelLabel).toBe(
      "v-mock",
    );
  });
});

describe("ProviderRegistry — spend guard", () => {
  const stashedKey = process.env["TEST_ANTHROPIC_KEY"];
  beforeEach(() => {
    process.env["TEST_ANTHROPIC_KEY"] = "test-glm-key";
  });
  afterEach(() => {
    if (stashedKey === undefined) delete process.env["TEST_ANTHROPIC_KEY"];
    else process.env["TEST_ANTHROPIC_KEY"] = stashedKey;
  });

  function makeGuardedConfig() {
    return parseConfig({
      roles: {
        researcher: { provider: "mock" },
        coder: {
          provider: "anthropic",
          baseUrl: "https://api.z.ai/api/anthropic",
          apiKeyEnv: "TEST_ANTHROPIC_KEY",
          model: "glm-4.6",
        },
        reviewer: { provider: "mock" },
      },
      spendAuthorization: {
        mode: "auto",
        maxUsdPerCall: 0.5,
        maxUsdPerSession: 50,
      },
    });
  }

  it("wraps a priced anthropic role in SpendGuardProvider", () => {
    const reg = new ProviderRegistry(makeGuardedConfig());
    const p = reg.getProviderForRole("coder");
    expect(p).toBeInstanceOf(SpendGuardProvider);
    expect(p.id).toBe("anthropic");
    expect(p.modelLabel).toBe("glm-4.6");
  });

  it("does NOT wrap mock (free) roles even when spendAuthorization is set", () => {
    const reg = new ProviderRegistry(makeGuardedConfig());
    const p = reg.getProviderForRole("researcher");
    expect(p).toBeInstanceOf(MockProvider);
    expect(p).not.toBeInstanceOf(SpendGuardProvider);
  });

  it("bare anthropic role WITHOUT spendAuthorization is NOT wrapped (existing behaviour unchanged)", () => {
    // makeConfig() from the top of this file never sets spendAuthorization.
    const reg = new ProviderRegistry(
      makeConfig({
        provider: "anthropic",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnv: "TEST_ANTHROPIC_KEY",
        model: "glm-4.6",
      }),
    );
    const p = reg.getProviderForRole("coder");
    expect(p).toBeInstanceOf(AnthropicCompatibleProvider);
    expect(p).not.toBeInstanceOf(SpendGuardProvider);
  });
});
