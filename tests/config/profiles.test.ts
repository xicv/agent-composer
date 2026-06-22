import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/loader.js";
import { resolveEffectiveConfig } from "../../src/config/profiles.js";

const BASE = {
  roles: {
    researcher: { provider: "mock", model: "researcher-base" },
    coder: {
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "glm-4.6",
    },
    reviewer: { provider: "mock", model: "reviewer-base" },
  },
} as const;

describe("resolveEffectiveConfig", () => {
  it("leaves configs without profiles unchanged", () => {
    const config = parseConfig(BASE);
    const resolved = resolveEffectiveConfig(config, {});

    expect(resolved.config).toEqual(config);
    expect(resolved.config).not.toBe(config);
    expect(resolved.resolvedProfile).toBeNull();
    expect(resolved.resolvedProfileSource).toBe("default");
    expect(resolved.warnings).toEqual([]);
    expect(resolved.effectiveFallbacks).toEqual({});
  });

  it("does not let no-profile resolved role mutations affect the input config", () => {
    const config = parseConfig(BASE);
    const resolved = resolveEffectiveConfig(config, {});

    resolved.config.roles.coder = { provider: "mock", model: "mutated-coder" };

    expect(config.roles.coder).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "glm-4.6",
    });
  });

  it("atomically replaces named roles without carrying stale provider fields", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "cli-coder",
      profiles: {
        "cli-coder": {
          roles: {
            coder: { provider: "cli", cli: ["codex", "exec"] },
          },
        },
      },
    });

    const resolved = resolveEffectiveConfig(config, {});

    expect(resolved.config.roles.coder).toEqual({
      provider: "cli",
      cli: ["codex", "exec"],
    });
    expect(resolved.config.roles.coder).not.toHaveProperty("baseUrl");
    expect(resolved.config.roles.coder).not.toHaveProperty("apiKeyEnv");
    expect(resolved.config.roles.coder).not.toHaveProperty("model");
  });

  it("resolves profile precedence as env over activeProfile over default", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "from-config",
      profiles: {
        "from-config": { roles: { coder: { provider: "mock", model: "config-coder" } } },
        "from-env": { roles: { coder: { provider: "mock", model: "env-coder" } } },
      },
    });

    const envResolved = resolveEffectiveConfig(config, { COMPOSER_PROFILE: "from-env" });
    expect(envResolved.resolvedProfile).toBe("from-env");
    expect(envResolved.resolvedProfileSource).toBe("env");
    expect(envResolved.config.roles.coder.model).toBe("env-coder");

    const configResolved = resolveEffectiveConfig(config, {});
    expect(configResolved.resolvedProfile).toBe("from-config");
    expect(configResolved.resolvedProfileSource).toBe("config");
    expect(configResolved.config.roles.coder.model).toBe("config-coder");

    const defaultResolved = resolveEffectiveConfig(parseConfig(BASE), {});
    expect(defaultResolved.resolvedProfile).toBeNull();
    expect(defaultResolved.resolvedProfileSource).toBe("default");
  });

  it("fails closed when the env-selected profile is unknown", () => {
    const config = parseConfig({
      ...BASE,
      profiles: {
        known: { roles: { coder: { provider: "mock", model: "known" } } },
      },
    });

    expect(() =>
      resolveEffectiveConfig(config, { COMPOSER_PROFILE: "missing" }),
    ).toThrow(/COMPOSER_PROFILE.*missing.*not found/);
  });

  it("fails closed when activeProfile is unknown", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "missing",
      profiles: {
        known: { roles: { coder: { provider: "mock", model: "known" } } },
      },
    });

    expect(() => resolveEffectiveConfig(config, {})).toThrow(
      /activeProfile.*missing.*not found/,
    );
  });

  it("rejects fallback self references", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: { fallbacks: { coder: ["coder"] } },
      },
    });

    expect(() => resolveEffectiveConfig(config, {})).toThrow(/fallback.*coder.*itself/);
  });

  it("rejects fallback cycles within the same role intent", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: {
          roles: {
            coderCli: { provider: "mock", model: "cli-coder" },
          },
          fallbacks: { coder: ["coderCli"], coderCli: ["coder"] },
        },
      },
    });

    expect(() => resolveEffectiveConfig(config, {})).toThrow(/fallback cycle/i);
  });

  it("rejects duplicate fallback targets", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: {
          roles: {
            reviewerClaude: { provider: "mock", model: "claude-reviewer" },
          },
          fallbacks: { reviewer: ["reviewerClaude", "reviewerClaude"] },
        },
      },
    });

    expect(() => resolveEffectiveConfig(config, {})).toThrow(/duplicate fallback/i);
  });

  it("accepts valid fallback chains when every target resolves to a configured role and intent", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "fallbacks",
      profiles: {
        fallbacks: {
          roles: {
            reviewerClaude: { provider: "mock", model: "claude-reviewer" },
            coderCli: { provider: "mock", model: "cli-coder" },
          },
          fallbacks: {
            reviewer: ["reviewerClaude"],
            coderCli: ["coder"],
          },
        },
      },
    });

    const resolved = resolveEffectiveConfig(config, {});
    expect(resolved.effectiveFallbacks).toEqual({
      reviewer: ["reviewerClaude"],
      coderCli: ["coder"],
    });
  });

  it("rejects fallback chains that cross read and mutate intents", () => {
    const mutateToRead = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: { fallbacks: { coder: ["reviewer"] } },
      },
    });
    const readToMutate = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: { fallbacks: { reviewer: ["coder"] } },
      },
    });

    expect(() => resolveEffectiveConfig(mutateToRead, {})).toThrow(
      /fallback.*coder.*MUTATE.*reviewer.*READ/i,
    );
    expect(() => resolveEffectiveConfig(readToMutate, {})).toThrow(
      /fallback.*reviewer.*READ.*coder.*MUTATE/i,
    );
  });

  it("rejects fallbacks to roles that do not resolve to a configured role", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "bad",
      profiles: {
        bad: { fallbacks: { reviewer: ["reviewerClaude"] } },
      },
    });

    expect(() => resolveEffectiveConfig(config, {})).toThrow(
      /fallback target.*reviewerClaude.*not configured/,
    );
  });

  it("warns when coder and reviewer roles resolve to the same provider identity", () => {
    const config = parseConfig({
      ...BASE,
      activeProfile: "same",
      profiles: {
        same: {
          roles: {
            coder: { provider: "mock", model: "same-model" },
            reviewer: { provider: "mock", model: "same-model" },
          },
        },
      },
    });

    const resolved = resolveEffectiveConfig(config, {});

    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toMatch(/coder.*reviewer.*same provider/i);
  });
});
