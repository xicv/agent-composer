import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPOSER_STATE_DIR_ENV } from "../util/codexLifecycleJob.js";

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
  try {
    const stateDir = composerStateDir();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(stateDir, "active-runs.json");
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = runs.map(({ tool, providerLabel, providerRole, startedAt }) => ({
      tool,
      ...(providerLabel ? { providerLabel } : {}),
      ...(providerRole ? { providerRole } : {}),
      startedAt,
    }));
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Statusline persistence is advisory only.
  }
}

function composerStateDir(): string {
  const override = process.env[COMPOSER_STATE_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".composer", "state");
}
