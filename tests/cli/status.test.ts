import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, renderStatusLine } from "../../src/cli/status.js";
import { newOracleJob, writeOracleJob } from "../../src/util/oracleJob.js";
import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";

const MINIMAL_CONFIG = JSON.stringify(
  {
    roles: {
      researcher: { provider: "mock", model: "researcher-mock" },
      coder: { provider: "mock", model: "coder-mock" },
      reviewer: { provider: "mock", model: "reviewer-mock" },
    },
  },
  null,
  2,
);

describe("buildStatus", () => {
  let tmp: string;
  let previousComposerConfig: string | undefined;
  let previousComposerStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-status-test-"));
    stateDir = mkdtempSync(join(tmpdir(), "composer-status-state-"));
    previousComposerConfig = process.env["COMPOSER_CONFIG"];
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    delete process.env["COMPOSER_CONFIG"];
    process.env[COMPOSER_STATE_DIR_ENV] = stateDir;
  });

  afterEach(() => {
    if (previousComposerConfig === undefined) delete process.env["COMPOSER_CONFIG"];
    else process.env["COMPOSER_CONFIG"] = previousComposerConfig;
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns config.exists:false and recommendation to init when composer.config.json is absent", () => {
    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(false);
    expect(status.integrations.codexReview).toBe(false);
    expect(status.integrations.codexLifecycle).toBe(false);
    expect(status.integrations.oraclePlanner).toBe(false);
    expect(status.integrations.gitHookInstalled).toBe(false);
    expect(status.recommendation.nextAction).toBe("agent-composer init");
  });

  it("returns config.exists:false when config file is invalid JSON", () => {
    writeFileSync(join(tmp, "composer.config.json"), "{ broken json", "utf8");

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(false);
  });

  it("returns config.exists:true with a minimal valid config; integrations all false", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(true);
    expect(status.integrations.codexReview).toBe(false);
    expect(status.integrations.codexLifecycle).toBe(false);
    expect(status.integrations.oraclePlanner).toBe(false);
    expect(status.integrations.gitHookInstalled).toBe(false);
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

    const status = buildStatus(tmp);

    expect(status.integrations.codexReview).toBe(true);
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

    const status = buildStatus(tmp);

    expect(status.integrations.codexLifecycle).toBe(true);
  });

  it("reflects oraclePlanner role presence in integrations.oraclePlanner", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
        oraclePlanner: { provider: "mock", model: "oracle" },
      },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.integrations.oraclePlanner).toBe(true);
  });

  it("reflects oracle.defaultMode and requireExplicitTag in config block", () => {
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

    const status = buildStatus(tmp);

    expect(status.integrations.oraclePlanner).toBe(true);
    expect(status.config.oracleDefaultMode).toBe("deep");
    expect(status.config.oracleRequireExplicitTag).toBe(true);
  });

  it("oracle fields are absent when oracle block not configured", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const status = buildStatus(tmp);

    expect(status.config.oracleDefaultMode).toBeUndefined();
    expect(status.config.oracleRequireExplicitTag).toBeUndefined();
  });

  it("honors COMPOSER_CONFIG env var to locate config", () => {
    const subDir = join(tmp, "nested");
    mkdirSync(subDir, { recursive: true });
    const customPath = join(subDir, "custom.config.json");
    writeFileSync(customPath, MINIMAL_CONFIG, "utf8");
    process.env["COMPOSER_CONFIG"] = customPath;

    const status = buildStatus(tmp);

    expect(status.config.exists).toBe(true);
    expect(status.config.path).toBe(customPath);
  });

  it("deriveMode: config with codexReview.enabled=false + codexLifecycle.enabled=false → mode 'fast'", () => {
    const config = {
      roles: {
        researcher: { provider: "mock", model: "r" },
        coder: { provider: "mock", model: "c" },
        reviewer: { provider: "mock", model: "v" },
      },
      codexReview: { enabled: false },
      codexLifecycle: { enabled: false },
    };
    writeFileSync(join(tmp, "composer.config.json"), JSON.stringify(config), "utf8");

    const status = buildStatus(tmp);

    expect(status.config.mode).toBe("fast");
  });

  it("active.oracleJob is populated when a running oracle job exists, with correct ageSeconds", () => {
    writeFileSync(join(tmp, "composer.config.json"), MINIMAL_CONFIG, "utf8");

    const job = newOracleJob(tmp, { mode: "research" });
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const runningJob = { ...job, status: "running" as const, startedAt };
    writeOracleJob(tmp, runningJob);

    const nowMs = Date.parse(startedAt) + 90_000;
    const status = buildStatus(tmp, { nowMs });

    expect(status.active.oracleJob).toBeDefined();
    expect(status.active.oracleJob?.status).toBe("running");
    expect(status.active.oracleJob?.jobId).toBe(job.jobId);
    const age = status.active.oracleJob?.ageSeconds ?? -1;
    expect(age).toBeGreaterThanOrEqual(88);
    expect(age).toBeLessThanOrEqual(92);
    expect(status.recommendation.nextAction).toBe("composer_oracle_job_result");
  });
});

describe("renderStatusLine", () => {
  it("returns a single line starting with 'CMP ' containing R: L: O: H: and no objective text", () => {
    const s = buildStatus(mkdtempSync(join(tmpdir(), "composer-renderline-")));
    const line = renderStatusLine(s);

    expect(line.trim().split("\n").length).toBe(1);
    expect(line).toMatch(/^CMP /);
    expect(line).toContain("R:");
    expect(line).toContain("L:");
    expect(line).toContain("O:");
    expect(line).toContain("H:");
    // Must NOT contain objective/prompt/note style text
    expect(line).not.toContain("objective");
    expect(line).not.toContain("prompt");
    expect(line).not.toContain("note");
  });
});
