import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus } from "../../src/cli/status.js";

const MINIMAL_CONFIG = JSON.stringify({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
  },
}, null, 2);

describe("buildStatus", () => {
  let tmp: string;
  let previousComposerConfig: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-status-test-"));
    previousComposerConfig = process.env["COMPOSER_CONFIG"];
    // Use default name so buildStatus finds <cwd>/composer.config.json
    delete process.env["COMPOSER_CONFIG"];
  });

  afterEach(() => {
    if (previousComposerConfig === undefined) delete process.env["COMPOSER_CONFIG"];
    else process.env["COMPOSER_CONFIG"] = previousComposerConfig;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns configExists:false when composer.config.json is absent", () => {
    const report = buildStatus(tmp);

    expect(report.configExists).toBe(false);
    expect(report.codexReview).toBe(false);
    expect(report.codexLifecycle).toBe(false);
    expect(report.oracleConfigured).toBe(false);
    expect(report.gitHookInstalled).toBe(false);
  });

  it("returns configExists:false when config file is invalid JSON", () => {
    writeFileSync(join(tmp, "composer.config.json"), "{ broken json", "utf8");

    const report = buildStatus(tmp);

    expect(report.configExists).toBe(false);
  });

  it("returns configExists:true with a minimal valid config", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const report = buildStatus(tmp);

    expect(report.configExists).toBe(true);
    expect(report.codexReview).toBe(false);
    expect(report.codexLifecycle).toBe(false);
    expect(report.oracleConfigured).toBe(false);
    expect(report.gitHookInstalled).toBe(false);
  });

  it("reflects codexReview.enabled from config", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexReview: { enabled: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const report = buildStatus(tmp);

    expect(report.codexReview).toBe(true);
  });

  it("reflects codexLifecycle.enabled from config", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexLifecycle: { enabled: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const report = buildStatus(tmp);

    expect(report.codexLifecycle).toBe(true);
  });

  it("reflects oraclePlanner role presence", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const report = buildStatus(tmp);

    expect(report.oracleConfigured).toBe(true);
  });

  it("reflects oracle.defaultMode and requireExplicitTag", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
      oracle: { defaultMode: "deep", requireExplicitTag: true },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const report = buildStatus(tmp);

    expect(report.oracleConfigured).toBe(true);
    expect(report.oracleDefaultMode).toBe("deep");
    expect(report.oracleRequireExplicitTag).toBe(true);
  });

  it("oracle fields are absent when oracle block not configured", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const report = buildStatus(tmp);

    expect(report.oracleDefaultMode).toBeUndefined();
    expect(report.oracleRequireExplicitTag).toBeUndefined();
  });

  it("honors COMPOSER_CONFIG env var to locate config", () => {
    const subDir = join(tmp, "nested");
    mkdirSync(subDir, { recursive: true });
    const customPath = join(subDir, "custom.config.json");
    writeFileSync(customPath, MINIMAL_CONFIG, "utf8");
    process.env["COMPOSER_CONFIG"] = customPath;

    const report = buildStatus(tmp);

    expect(report.configExists).toBe(true);
    expect(report.configPath).toBe(customPath);
  });
});
