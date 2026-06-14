import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTerminal, readGoal } from "../util/goal.js";

export interface CleanupOptions {
  oracle?: boolean;      // limit to oracle-kind roots
  state?: boolean;       // limit to ~/.local/state/composer roots
  olderThanMs?: number;  // only entries with mtime older than this age
  dryRun?: boolean;
}

interface CleanupEnv { projectRoot: string; stateDir: string; nowMs: number; }

interface CleanupRoot { dir: string; isOracle: boolean; isState: boolean; kind?: "goals"; }

function cleanupRoots(env: CleanupEnv): CleanupRoot[] {
  return [
    { dir: path.join(env.projectRoot, ".composer", "oracle"), isOracle: true, isState: false },
    { dir: path.join(env.projectRoot, ".composer", "results"), isOracle: false, isState: false },
    { dir: path.join(env.projectRoot, ".composer", "goals"), isOracle: false, isState: false, kind: "goals" },
    { dir: path.join(env.stateDir, "oracle-jobs"), isOracle: true, isState: true },
    { dir: path.join(env.stateDir, "oracle-locks"), isOracle: true, isState: true },
    { dir: path.join(env.stateDir, "codex-lifecycle"), isOracle: false, isState: true },
    { dir: path.join(env.stateDir, "audit"), isOracle: false, isState: true },
  ];
}

export function defaultStateDir(): string {
  const override = process.env["COMPOSER_STATE_DIR"]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".local", "state", "composer");
}

/** Pure: returns the absolute entry paths that cleanup would remove. */
export function planCleanup(opts: CleanupOptions, env: CleanupEnv): string[] {
  const roots = cleanupRoots(env).filter(
    (r) => (!opts.oracle || r.isOracle) && (!opts.state || r.isState),
  );
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    let st;
    try { st = lstatSync(root.dir); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue; // safety: never follow symlinks
    let entries: string[];
    try { entries = readdirSync(root.dir); } catch { continue; }
    if (root.kind === "goals") {
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(root.dir, name);
        if (opts.olderThanMs !== undefined) {
          let mtime = 0;
          try { mtime = statSync(full).mtimeMs; } catch { continue; }
          if (env.nowMs - mtime < opts.olderThanMs) continue;
        }
        const goalId = name.slice(0, -".json".length);
        try {
          const record = readGoal(env.projectRoot, goalId);
          if (record && isTerminal(record.state)) out.push(full);
        } catch {
          continue;
        }
      }
      continue;
    }
    for (const name of entries) {
      const full = path.join(root.dir, name);
      if (opts.olderThanMs !== undefined) {
        let mtime = 0;
        try { mtime = statSync(full).mtimeMs; } catch { continue; }
        if (env.nowMs - mtime < opts.olderThanMs) continue;
      }
      out.push(full);
    }
  }
  return out;
}

/** Parse `cleanup` flags. Returns CleanupOptions or an { error } message. */
export function parseCleanupArgs(flags: readonly string[]): CleanupOptions | { error: string } {
  const opts: CleanupOptions = {};
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--oracle") opts.oracle = true;
    else if (f === "--state") opts.state = true;
    else if (f === "--dry-run") opts.dryRun = true;
    else if (f === "--older-than" || f?.startsWith("--older-than=")) {
      const raw = f.includes("=") ? f.slice(f.indexOf("=") + 1) : flags[++i];
      const ms = parseDuration(raw);
      if (ms === null) return { error: `cleanup: invalid --older-than value: ${raw ?? "(missing)"} (use e.g. 14d, 12h, 30m)` };
      opts.olderThanMs = ms;
    } else return { error: `cleanup: unknown argument: ${f}` };
  }
  return opts;
}

function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000;
  return n * mult;
}

export function runCleanup(opts: CleanupOptions, env?: Partial<CleanupEnv>): { removed: string[]; dryRun: boolean } {
  const resolved: CleanupEnv = {
    projectRoot: env?.projectRoot ?? process.cwd(),
    stateDir: env?.stateDir ?? defaultStateDir(),
    nowMs: env?.nowMs ?? Date.now(),
  };
  const targets = planCleanup(opts, resolved);
  for (const t of targets) {
    if (opts.dryRun) {
      process.stdout.write(`would remove: ${t}\n`);
    } else {
      try { rmSync(t, { recursive: true, force: true }); process.stdout.write(`removed: ${t}\n`); }
      catch (e) { process.stderr.write(`failed to remove ${t}: ${e instanceof Error ? e.message : String(e)}\n`); }
    }
  }
  process.stdout.write(`cleanup: ${opts.dryRun ? "would remove" : "removed"} ${targets.length} item(s)\n`);
  return { removed: targets, dryRun: opts.dryRun === true };
}
