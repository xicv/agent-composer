import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseConfig, loadConfig } from "../../src/config/loader.js";

const VALID = {
  roles: {
    researcher: { provider: "cli", cli: ["agy", "--dangerously-skip-permissions", "-p"] },
    coder: {
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "glm-4.6",
    },
    reviewer: { provider: "cli", cli: ["agy", "-p"] },
  },
};

describe("parseConfig (zod mirror of composer.config.schema.json)", () => {
  it("accepts canonical plan-spec config", () => {
    expect(() => parseConfig(VALID)).not.toThrow();
  });

  it("rejects missing roles key", () => {
    expect(() => parseConfig({})).toThrow();
  });

  it("rejects missing researcher role", () => {
    expect(() =>
      parseConfig({
        roles: { coder: VALID.roles.coder, reviewer: VALID.roles.reviewer },
      }),
    ).toThrow();
  });

  it("rejects missing role.provider", () => {
    expect(() =>
      parseConfig({
        roles: { ...VALID.roles, coder: { baseUrl: "https://x" } },
      }),
    ).toThrow();
  });

  it("rejects unknown provider id", () => {
    expect(() =>
      parseConfig({
        roles: { ...VALID.roles, coder: { provider: "bogus" } },
      }),
    ).toThrow();
  });

  it("rejects additional properties at root (strict)", () => {
    expect(() => parseConfig({ ...VALID, bogus: 1 })).toThrow();
  });

  it("rejects additional properties on role (strict)", () => {
    expect(() =>
      parseConfig({
        roles: {
          ...VALID.roles,
          coder: { provider: "anthropic", baseUrl: "https://x", bogus: 1 },
        },
      }),
    ).toThrow();
  });

  it("requires cli array to be non-empty when present", () => {
    expect(() =>
      parseConfig({
        roles: {
          ...VALID.roles,
          researcher: { provider: "cli", cli: [] },
        },
      }),
    ).toThrow();
  });

  it("accepts mock provider role", () => {
    expect(() =>
      parseConfig({
        roles: { ...VALID.roles, coder: { provider: "mock", model: "test" } },
      }),
    ).not.toThrow();
  });

  it("returns a typed config preserving values", () => {
    const cfg = parseConfig(VALID);
    expect(cfg.roles.coder.provider).toBe("anthropic");
    expect(cfg.roles.coder.model).toBe("glm-4.6");
    expect(cfg.roles.researcher.cli?.[0]).toBe("agy");
  });
});

describe("parseConfig — spendAuthorization (Wave 3 audit follow-up)", () => {
  it("accepts config without spendAuthorization (backward compat)", () => {
    const cfg = parseConfig(VALID);
    expect(cfg.spendAuthorization).toBeUndefined();
  });

  it("accepts mode=interactive (the documented default behaviour)", () => {
    const cfg = parseConfig({ ...VALID, spendAuthorization: { mode: "interactive" } });
    expect(cfg.spendAuthorization?.mode).toBe("interactive");
  });

  it("accepts mode=auto (skip per-call gate, rely on caps)", () => {
    const cfg = parseConfig({ ...VALID, spendAuthorization: { mode: "auto" } });
    expect(cfg.spendAuthorization?.mode).toBe("auto");
  });

  it("accepts mode=deny (block all real spend, force tape replay)", () => {
    const cfg = parseConfig({ ...VALID, spendAuthorization: { mode: "deny" } });
    expect(cfg.spendAuthorization?.mode).toBe("deny");
  });

  it("rejects unknown mode value", () => {
    expect(() =>
      parseConfig({ ...VALID, spendAuthorization: { mode: "yolo" } }),
    ).toThrow();
  });

  it("requires mode field when spendAuthorization present", () => {
    expect(() =>
      parseConfig({ ...VALID, spendAuthorization: {} }),
    ).toThrow();
  });

  it("accepts optional maxUsdPerSession + maxUsdPerCall caps", () => {
    const cfg = parseConfig({
      ...VALID,
      spendAuthorization: { mode: "auto", maxUsdPerSession: 1.0, maxUsdPerCall: 0.25 },
    });
    expect(cfg.spendAuthorization?.maxUsdPerSession).toBe(1.0);
    expect(cfg.spendAuthorization?.maxUsdPerCall).toBe(0.25);
  });

  it("rejects negative caps", () => {
    expect(() =>
      parseConfig({
        ...VALID,
        spendAuthorization: { mode: "auto", maxUsdPerCall: -0.01 },
      }),
    ).toThrow();
  });

  it("rejects additional properties on spendAuthorization (strict)", () => {
    expect(() =>
      parseConfig({
        ...VALID,
        spendAuthorization: { mode: "auto", bogus: 1 },
      }),
    ).toThrow();
  });
});

describe("loadConfig (disk)", () => {
  it("loads + validates JSON file from disk", () => {
    const tmp = path.join(os.tmpdir(), `composer-cfg-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(VALID));
    try {
      const cfg = loadConfig(tmp);
      expect(cfg.roles.coder.provider).toBe("anthropic");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("throws on missing file with informative path", () => {
    expect(() =>
      loadConfig("/tmp/definitely-does-not-exist-xyz.json"),
    ).toThrow(/not found/);
  });

  it("throws on malformed JSON with explanation", () => {
    const tmp = path.join(os.tmpdir(), `composer-bad-${Date.now()}.json`);
    fs.writeFileSync(tmp, "{ not: 'json' }");
    try {
      expect(() => loadConfig(tmp)).toThrow(/JSON/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
