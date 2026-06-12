import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import {
  newOracleJob,
  readOracleJob,
  writeOracleJob,
} from "../../src/util/oracleJob.js";

describe("oracle job files", () => {
  let composerStateDir: string | undefined;
  let previousComposerStateDir: string | undefined;

  beforeEach(() => {
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    composerStateDir = mkdtempSync(join(tmpdir(), "composer-oracle-state-"));
    process.env[COMPOSER_STATE_DIR_ENV] = composerStateDir;
  });

  afterEach(() => {
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    if (composerStateDir) rmSync(composerStateDir, { recursive: true, force: true });
    composerStateDir = undefined;
    previousComposerStateDir = undefined;
  });

  it("round-trips queued jobs from the current process without reconciliation", () => {
    const root = process.cwd();
    const job = newOracleJob(root, { mode: "standard" });
    writeOracleJob(root, job);

    const read = readOracleJob(root, job.jobId);

    expect(read?.status).toBe("queued");
    expect(read?.pid).toBe(process.pid);
  });

  it("persists job files with owner-only permissions", () => {
    const root = process.cwd();
    const job = newOracleJob(root, { mode: "standard" });
    const written = writeOracleJob(root, job);

    expect(statSync(written.resultPath).mode & 0o777).toBe(0o600);
  });

  it("reconciles and persists orphaned foreign running jobs", () => {
    const root = process.cwd();
    const job = newOracleJob(root, { mode: "debug" });
    writeOracleJob(root, {
      ...job,
      status: "running",
      pid: 2147483646,
    });

    const read = readOracleJob(root, job.jobId);

    expect(read?.status).toBe("failed");
    expect(read?.error).toContain("orphaned");

    const reread = readOracleJob(root, job.jobId);
    expect(reread?.status).toBe("failed");
  });

  it("does not reconcile running jobs owned by the current process", () => {
    const root = process.cwd();
    const job = newOracleJob(root, { mode: "research" });
    writeOracleJob(root, {
      ...job,
      status: "running",
      pid: process.pid,
    });

    const read = readOracleJob(root, job.jobId);

    expect(read?.status).toBe("running");
    expect(read?.pid).toBe(process.pid);
  });
});
