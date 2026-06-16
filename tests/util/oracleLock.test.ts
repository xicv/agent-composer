import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPOSER_STATE_DIR_ENV } from "../../src/util/codexLifecycleJob.js";
import { acquireOracleLock, ORACLE_LOCK_DIR } from "../../src/util/oracleLock.js";

describe("oracle lock files", () => {
  let composerStateDir: string | undefined;
  let previousComposerStateDir: string | undefined;

  beforeEach(() => {
    previousComposerStateDir = process.env[COMPOSER_STATE_DIR_ENV];
    composerStateDir = mkdtempSync(join(tmpdir(), "composer-oracle-lock-state-"));
    process.env[COMPOSER_STATE_DIR_ENV] = composerStateDir;
  });

  afterEach(() => {
    if (previousComposerStateDir === undefined) delete process.env[COMPOSER_STATE_DIR_ENV];
    else process.env[COMPOSER_STATE_DIR_ENV] = previousComposerStateDir;
    if (composerStateDir) rmSync(composerStateDir, { recursive: true, force: true });
    composerStateDir = undefined;
    previousComposerStateDir = undefined;
  });

  it("acquires again after release", () => {
    const root = process.cwd();
    const first = acquireOracleLock(root, { label: "first" });

    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected first lock acquisition");
    first.handle.release();

    const second = acquireOracleLock(root, { label: "second" });

    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error("expected second lock acquisition");
    second.handle.release();
  });

  it("rejects a second concurrent lock in the same process", () => {
    const root = process.cwd();
    const first = acquireOracleLock(root, { label: "first" });
    expect(first.acquired).toBe(true);
    const second = acquireOracleLock(root, { label: "second" });
    expect(second.acquired).toBe(false);
    if (first.acquired) first.handle.release();
  });

  it("recovers a live stale lock after the TTL", () => {
    const root = process.cwd();
    const lockPath = expectedLockPath(root);
    const nowMs = Date.parse("2026-06-16T00:00:00Z");
    mkdirSync(join(composerStateDir!, ORACLE_LOCK_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "stale-token",
        label: "stale",
        startedAt: new Date(nowMs - 2_000).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const lock = acquireOracleLock(
      root,
      { label: "replacement" },
      { ttlMs: 1_000, nowMs: () => nowMs },
    );

    expect(lock.acquired).toBe(true);
    if (!lock.acquired) throw new Error("expected stale lock to be stolen");
    expect(lock.recovery?.reasonCode).toBe("stale_lock_recovery");
    expect(lock.recovery?.lockAgeMs).toBeGreaterThanOrEqual(2_000);
    lock.handle.release();
  });

  it("uses lock mtime as a stale fallback when startedAt is clock-skewed into the future", () => {
    const root = process.cwd();
    const lockPath = expectedLockPath(root);
    const nowMs = Date.parse("2026-06-16T00:00:00Z");
    mkdirSync(join(composerStateDir!, ORACLE_LOCK_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "future-token",
        label: "future-skew",
        startedAt: new Date(nowMs + 60_000).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const old = new Date(nowMs - 2_000);
    utimesSync(lockPath, old, old);

    const lock = acquireOracleLock(
      root,
      { label: "replacement" },
      { ttlMs: 1_000, nowMs: () => nowMs },
    );

    expect(lock.acquired).toBe(true);
    if (!lock.acquired) throw new Error("expected skewed stale lock to be stolen");
    expect(lock.recovery?.reasonCode).toBe("stale_lock_recovery");
    expect(lock.recovery?.lockAgeMs).toBeGreaterThanOrEqual(2_000);
    lock.handle.release();
  });

  it("steals a stale lock with a dead pid", () => {
    const root = process.cwd();
    const lockPath = expectedLockPath(root);
    mkdirSync(join(composerStateDir!, ORACLE_LOCK_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 2147483646,
        jobId: "stale-job",
        label: "stale",
        startedAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const lock = acquireOracleLock(root, { label: "replacement" });

    expect(lock.acquired).toBe(true);
    if (!lock.acquired) throw new Error("expected stale lock to be stolen");
    lock.handle.release();
  });

  it("release removes the lock file", () => {
    const root = process.cwd();
    const lockPath = expectedLockPath(root);
    const lock = acquireOracleLock(root, { label: "release-check" });

    expect(lock.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    if (!lock.acquired) throw new Error("expected lock acquisition");
    lock.handle.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  function expectedLockPath(root: string): string {
    const rootReal = realpathSync(root);
    const key = projectStateKey(rootReal);
    return join(composerStateDir!, ORACLE_LOCK_DIR, `${key}.lock`);
  }

  function projectStateKey(rootReal: string): string {
    const name = basename(rootReal).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
    const slug = name.slice(0, 48);
    const digest = createHash("sha256").update(rootReal).digest("hex").slice(0, 24);
    return `${slug}-${digest}`;
  }
});
