import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ProviderRegistry,
  ProviderNotImplementedError,
  ProviderConfigError,
} from "../src/registry.js";
import { MockProvider } from "../src/providers/MockProvider.js";
import { AnthropicCompatibleProvider } from "../src/providers/AnthropicCompatibleProvider.js";
import { CLIProvider } from "../src/providers/CLIProvider.js";
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
