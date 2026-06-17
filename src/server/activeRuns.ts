import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPOSER_STATE_DIR_ENV } from "../util/codexLifecycleJob.js";

const ACTIVE_RUN_TTL_MS_ENV = "COMPOSER_ACTIVE_RUN_TTL_MS";
const DEFAULT_STALE_RUN_TTL_MS = 2 * 60 * 60_000;
const STALE_RUN_TTL_MS = resolvePositiveEnvMs(
  ACTIVE_RUN_TTL_MS_ENV,
  DEFAULT_STALE_RUN_TTL_MS,
);
let persistQueue: Promise<void> = Promise.resolve();

export interface ActiveRun {
  id: number;
  tool: string;
  providerLabel?: string;
  providerRole?: string;
  startedAt: string; // ISO
}

export interface ActiveRunTracker {
  start(input: { tool: string; providerRole?: string; providerLabel?: string }): number;
  finish(id: number): void;
  list(): ActiveRun[];
}

export function createActiveRunTracker(): ActiveRunTracker {
  let nextId = 1;
  const runs = new Map<number, ActiveRun>();
  prunePersistedActiveRuns(STALE_RUN_TTL_MS);
  return {
    start({ tool, providerRole, providerLabel }) {
      const id = nextId++;
      runs.set(id, {
        id,
        tool,
        providerRole,
        providerLabel,
        startedAt: new Date().toISOString(),
      });
      persistActiveRuns([...runs.values()]);
      return id;
    },
    finish(id) {
      runs.delete(id);
      persistActiveRuns([...runs.values()]);
    },
    list() {
      return [...runs.values()];
    },
  };
}

function persistActiveRuns(runs: ActiveRun[]): void {
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => persistActiveRunsAsync(runs))
    .catch(() => {
      // Statusline persistence is advisory only.
    });
}

async function persistActiveRunsAsync(runs: ActiveRun[]): Promise<void> {
  const stateDir = composerStateDir();
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDir, "active-runs.json");
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = activeRunPayload(runs);
  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function prunePersistedActiveRuns(ttlMs: number): void {
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => prunePersistedActiveRunsAsync(ttlMs))
    .catch(() => {
      // Statusline persistence is advisory only.
    });
}

async function prunePersistedActiveRunsAsync(ttlMs: number): Promise<void> {
  const filePath = path.join(composerStateDir(), "active-runs.json");
  const raw = await fs.promises.readFile(filePath, "utf8").catch(() => undefined);
  if (raw === undefined) return;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return;
  const cutoff = Date.now() - ttlMs;
  const fresh = parsed.filter((entry): entry is ActiveRun => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ActiveRun>;
    if (typeof candidate.tool !== "string" || typeof candidate.startedAt !== "string") {
      return false;
    }
    const startedAtMs = Date.parse(candidate.startedAt);
    return Number.isFinite(startedAtMs) && startedAtMs >= cutoff;
  });
  if (fresh.length === parsed.length) return;
  await persistActiveRunsAsync(fresh);
}

function activeRunPayload(runs: ActiveRun[]): Array<Omit<ActiveRun, "id">> {
  return runs.map(({ tool, providerLabel, providerRole, startedAt }) => ({
    tool,
    ...(providerLabel ? { providerLabel } : {}),
    ...(providerRole ? { providerRole } : {}),
    startedAt,
  }));
}

function composerStateDir(): string {
  const override = process.env[COMPOSER_STATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".composer", "state");
}

function resolvePositiveEnvMs(envName: string, fallbackMs: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}
