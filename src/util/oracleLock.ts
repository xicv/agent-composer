import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { COMPOSER_STATE_DIR_ENV } from "./codexLifecycleJob.js";

export const ORACLE_LOCK_DIR = "oracle-locks";
const ORACLE_LOCK_TTL_MS = 30 * 60 * 1000; // generous: longer than any Oracle run

type OracleLockHolder = {
  pid: number;
  token: string;
  jobId?: string;
  label?: string;
  startedAt: string;
};

export interface OracleLockHandle {
  release(): void;
}

export type OracleLockResult =
  | { acquired: true; handle: OracleLockHandle }
  | { acquired: false; holder: OracleLockHolder };

export function acquireOracleLock(
  root: string,
  info: { jobId?: string; label?: string },
): OracleLockResult {
  const lockPath = oracleLockPath(root);
  const token = randomUUID();
  const holder: OracleLockHolder = {
    pid: process.pid,
    token,
    jobId: info.jobId,
    label: info.label,
    startedAt: new Date().toISOString(),
  };

  try {
    return writeLock(lockPath, holder, token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = readLockHolder(lockPath);
  // Steal ONLY a malformed lock, a dead-process lock, or a stale lock.
  // A live holder (including the SAME process) is a real concurrent holder.
  if (!existing || !isProcessAlive(existing.pid) || isStaleLock(existing.startedAt)) {
    rmSync(lockPath, { force: true });
    try {
      return writeLock(lockPath, holder, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const racer = readLockHolder(lockPath);
        if (racer) return { acquired: false, holder: racer };
      }
      throw error;
    }
  }

  return { acquired: false, holder: existing };
}

function oracleLockPath(root: string): string {
  const rootReal = realpathSync(root);
  const stateRoot = oracleStateRoot();
  const lockRoot = path.join(stateRoot, ORACLE_LOCK_DIR);
  ensureDirectory(stateRoot, "Composer state root");
  ensureDirectory(lockRoot, "Oracle lock state root");
  return path.join(lockRoot, `${projectStateKey(rootReal)}.lock`);
}

function writeLock(lockPath: string, holder: OracleLockHolder, token: string): OracleLockResult {
  writeFileSync(lockPath, JSON.stringify(holder), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    acquired: true,
    handle: {
      release: () => {
        try {
          const current = readLockHolder(lockPath);
          if (current?.pid === process.pid && current.token === token) {
            rmSync(lockPath, { force: true });
          }
        } catch {
          // Best-effort cleanup only.
        }
      },
    },
  };
}

function readLockHolder(lockPath: string): OracleLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as OracleLockHolder;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.token !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function oracleStateRoot(): string {
  const override = process.env[COMPOSER_STATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".local", "state", "composer");
}

function projectStateKey(rootReal: string): string {
  const basename = path.basename(rootReal).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const slug = basename.slice(0, 48);
  const digest = createHash("sha256").update(rootReal).digest("hex").slice(0, 24);
  return `${slug}-${digest}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but not signalable by us -> alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStaleLock(startedAt: string): boolean {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > ORACLE_LOCK_TTL_MS;
}

function ensureDirectory(dir: string, label: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  assertUsableDirectory(dir, label);
}

function assertUsableDirectory(dir: string, label: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Oracle lock directory must not be a symlink: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Oracle lock path must be a directory: ${label}`);
  }
}
