#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = process.env.COMPOSER_STATE_DIR?.trim()
  ? path.resolve(process.env.COMPOSER_STATE_DIR)
  : path.join(os.homedir(), ".composer", "state");
const filePath = path.join(stateDir, "active-runs.json");

try {
  if (!fs.existsSync(filePath)) process.exit(0);
  const runs = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(runs) || runs.length === 0) process.exit(0);

  const now = Date.now();
  const active = runs
    .map((run) => ({
      tool: typeof run.tool === "string" ? run.tool : "",
      providerLabel: typeof run.providerLabel === "string" ? run.providerLabel : undefined,
      providerRole: typeof run.providerRole === "string" ? run.providerRole : undefined,
      startedAtMs: Date.parse(run.startedAt),
    }))
    .filter((run) => run.tool && Number.isFinite(run.startedAtMs))
    .sort((a, b) => a.startedAtMs - b.startedAtMs)[0];

  if (!active) process.exit(0);
  const tool = active.tool.replace(/^composer_/, "");
  const provider = active.providerLabel ?? active.providerRole;
  const elapsed = formatElapsed(now - active.startedAtMs);
  process.stdout.write(`⚡composer: ${tool}${provider ? `(${provider})` : ""} ${elapsed}\n`);
} catch {
  process.exit(0);
}

function formatElapsed(elapsedMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
