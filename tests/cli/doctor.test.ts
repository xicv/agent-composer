import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigChecks,
  isHealthy,
  resolveCodexPluginRoot,
  type DoctorCheck,
} from "../../src/cli/doctor.js";
import type { ComposerConfig } from "../../src/config/schema.js";

const BASE_CONFIG: ComposerConfig = {
  roles: {
    researcher: { provider: "cli", cli: ["agy", "-p"] },
    coder: {
      provider: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "glm-4.6",
    },
    reviewer: { provider: "cli", cli: ["agy", "-p"] },
  },
};

describe("doctor Codex plugin discovery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-doctor-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the marketplaces plugin path when present", () => {
    const root = join(tmp, "marketplaces", "openai-codex", "plugins", "codex");
    writeFakeCodexPlugin(root, "2.3.4");

    const result = resolveCodexPluginRoot(tmp);

    expect(result).toEqual({ root, version: "2.3.4" });
  });

  it("picks the highest semver cache plugin when marketplaces path is absent", () => {
    writeFakeCodexPlugin(join(tmp, "cache", "openai-codex", "codex", "1.0.2"), "1.0.2");
    writeFakeCodexPlugin(join(tmp, "cache", "openai-codex", "codex", "1.0.4"), "1.0.4");

    const result = resolveCodexPluginRoot(tmp);

    expect(result?.root).toBe(join(tmp, "cache", "openai-codex", "codex", "1.0.4"));
    expect(result?.version).toBe("1.0.4");
  });

  it("returns null when no Codex plugin is available", () => {
    expect(resolveCodexPluginRoot(tmp)).toBeNull();
  });
});

describe("doctor config checks", () => {
  it("reports codexReview.enabled=false as an optional warn", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: { enabled: false },
    });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.find((check) => check.name === "config: codexReview")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("OFF"),
    });
  });

  it("reports enabled triggers and resolved defaults without throwing", () => {
    const checks = buildConfigChecks({
      ...BASE_CONFIG,
      codexReview: {
        enabled: true,
        triggers: { preCommit: true, postPlan: true },
      },
    });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.find((check) => check.name === "config: codexReview")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("ON"),
    });
    expect(checks.find((check) => check.name === "config: codexReview triggers")?.detail)
      .toContain("preCommit=true, postPlan=true");
    const defaults = checks.find((check) => check.name === "config: codexReview defaults")?.detail;
    expect(defaults).toContain("mode=ask");
    expect(defaults).toContain("execution=background");
  });
});

describe("doctor health", () => {
  it("marks a report unhealthy when any check fails", () => {
    expect(isHealthy([
      passCheck(),
      { name: "codex CLI", status: "fail", detail: "missing" },
    ])).toBe(false);
  });

  it("marks a report healthy when checks are only pass or warn", () => {
    expect(isHealthy([
      passCheck(),
      { name: "codex review", status: "warn", detail: "optional off" },
    ])).toBe(true);
  });
});

function writeFakeCodexPlugin(root: string, version: string): void {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }), "utf8");
  writeFileSync(join(root, "scripts", "codex-companion.mjs"), "", "utf8");
  expect(existsSync(join(root, "scripts", "codex-companion.mjs"))).toBe(true);
}

function passCheck(): DoctorCheck {
  return { name: "ok", status: "pass", detail: "ok" };
}
