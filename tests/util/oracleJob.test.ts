import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import {
  newOracleJob,
  readLatestOracleJob,
  readOracleJob,
  updateOracleJob,
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

  it("round-trips async Oracle full-answer metadata", () => {
    const root = process.cwd();
    const job = writeOracleJob(root, newOracleJob(root, { mode: "standard" }));
    const updated = updateOracleJob(root, job, {
      status: "succeeded",
      answerText: "x",
      answerPath: ".composer/oracle/answers/foo.md",
      oracleSlug: "foo",
    });

    const read = readOracleJob(root, updated.jobId);

    expect(read?.answerText).toBe("x");
    expect(read?.answerPath).toBe(".composer/oracle/answers/foo.md");
    expect(read?.oracleSlug).toBe("foo");
  });

  it("readLatestOracleJob uses a valid latest pointer", () => {
    const root = process.cwd();
    const first = writeOracleJob(root, newOracleJob(root, { mode: "quick" }));
    const second = writeOracleJob(root, newOracleJob(root, { mode: "deep" }));

    expect(readLatestOracleJob(root)?.jobId).toBe(second.jobId);
    expect(readLatestOracleJob(root)?.jobId).not.toBe(first.jobId);
  });

  it("readLatestOracleJob falls back to scan when the pointer target is deleted", () => {
    const root = process.cwd();
    const first = writeOracleJob(root, newOracleJob(root, { mode: "quick" }));
    const second = writeOracleJob(root, newOracleJob(root, { mode: "deep" }));
    const newer = new Date(Date.now() + 10_000);
    utimesSync(first.resultPath, newer, newer);
    unlinkSync(second.resultPath);

    expect(readLatestOracleJob(root)?.jobId).toBe(first.jobId);
  });

  it("readLatestOracleJob falls back to scan when the pointer is corrupt", () => {
    const root = process.cwd();
    const first = writeOracleJob(root, newOracleJob(root, { mode: "quick" }));
    const second = writeOracleJob(root, newOracleJob(root, { mode: "deep" }));
    const newer = new Date(Date.now() + 10_000);
    utimesSync(second.resultPath, newer, newer);
    writeFileSync(join(dirname(second.resultPath), ".latest"), "not-a-job-id\n", "utf8");

    expect(readLatestOracleJob(root)?.jobId).toBe(second.jobId);
    expect(readLatestOracleJob(root)?.jobId).not.toBe(first.jobId);
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
