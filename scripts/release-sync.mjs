#!/usr/bin/env node
// Wave 4 M0.5 — release sync.
//
// Snapshots the dev `.claude/` instance into `plugin/composer-mastermind/`
// at a version bump. Refuses to overwrite the frozen plugin without an
// explicit --bump argument.
//
// Usage:
//   node scripts/release-sync.mjs --check                 # dry-run, exit 1 if drift
//   node scripts/release-sync.mjs --bump 0.2.0            # sync + bump version
//
// Per ADR 0002 M0.5: dev instance is /evolve-mutable; plugin/ is the
// frozen release snapshot. Release commits re-sync.

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SYNC_PAIRS = [
  { src: ".claude/skills/composer-mastermind/SKILL.md", dest: "plugin/composer-mastermind/skills/composer-mastermind/SKILL.md" },
  { src: ".claude/agents/coder.md",                     dest: "plugin/composer-mastermind/agents/coder.md" },
  { src: ".claude/agents/researcher.md",                dest: "plugin/composer-mastermind/agents/researcher.md" },
  { src: ".claude/agents/reviewer.md",                  dest: "plugin/composer-mastermind/agents/reviewer.md" },
  { src: ".claude/agents/reviewer-claude.md",           dest: "plugin/composer-mastermind/agents/reviewer-claude.md" },
  { src: ".claude/agents/explorer.md",                  dest: "plugin/composer-mastermind/agents/explorer.md" },
  { src: ".claude/commands/evolve.md",                  dest: "plugin/composer-mastermind/commands/evolve.md" },
  { src: "scripts/boundary_guard.sh",                   dest: "plugin/composer-mastermind/hooks/boundary_guard.sh", exec: true },
  { src: "scripts/learn.sh",                            dest: "plugin/composer-mastermind/hooks/learn.sh",          exec: true },
];

const MANIFEST_PATH = "plugin/composer-mastermind/plugin.json";

function md5(path) {
  return createHash("md5").update(readFileSync(resolve(REPO_ROOT, path))).digest("hex");
}

function parseArgs(argv) {
  const args = { check: false, bump: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") args.check = true;
    else if (argv[i] === "--bump") args.bump = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function cmpSemver(a, b) {
  const [aMajor, aMinor, aPatch] = a.split(".").map((n) => parseInt(n, 10));
  const [bMajor, bMinor, bPatch] = b.split(".").map((n) => parseInt(n, 10));
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

function isValidSemver(s) {
  return /^\d+\.\d+\.\d+$/.test(s);
}

export function diffSyncPairs() {
  const records = [];
  for (const pair of SYNC_PAIRS) {
    const srcAbs = resolve(REPO_ROOT, pair.src);
    const destAbs = resolve(REPO_ROOT, pair.dest);
    if (!existsSync(srcAbs)) {
      records.push({ ...pair, status: "missing-source" });
      continue;
    }
    if (!existsSync(destAbs)) {
      records.push({ ...pair, status: "missing-dest" });
      continue;
    }
    const same = md5(pair.src) === md5(pair.dest);
    records.push({ ...pair, status: same ? "identical" : "drifted", srcHash: md5(pair.src), destHash: md5(pair.dest) });
  }
  return records;
}

export function applySync() {
  let touched = 0;
  for (const pair of SYNC_PAIRS) {
    const srcAbs = resolve(REPO_ROOT, pair.src);
    const destAbs = resolve(REPO_ROOT, pair.dest);
    if (!existsSync(srcAbs)) continue;
    copyFileSync(srcAbs, destAbs);
    if (pair.exec) chmodSync(destAbs, 0o755);
    touched++;
  }
  return touched;
}

export function bumpManifestVersion(nextVersion) {
  const path = resolve(REPO_ROOT, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const current = manifest.version;
  if (!isValidSemver(nextVersion)) throw new Error(`--bump: "${nextVersion}" is not semver MAJOR.MINOR.PATCH`);
  if (cmpSemver(nextVersion, current) <= 0) {
    throw new Error(`--bump: ${nextVersion} is not greater than current ${current} (no downgrade)`);
  }
  manifest.version = nextVersion;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { from: current, to: nextVersion };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.check && !args.bump) {
    console.error("usage: release-sync.mjs --check | --bump <semver>");
    process.exit(2);
  }
  const records = diffSyncPairs();
  const missingSrc = records.filter((r) => r.status === "missing-source");
  if (missingSrc.length) {
    for (const r of missingSrc) console.error(`  ! missing source: ${r.src}`);
    process.exit(2);
  }
  const drifted = records.filter((r) => r.status === "drifted" || r.status === "missing-dest");
  for (const r of records) {
    const tag = r.status === "identical" ? "=" : r.status === "drifted" ? "~" : "+";
    console.log(`  ${tag} ${r.src}  →  ${r.dest}  [${r.status}]`);
  }
  if (args.check) {
    if (drifted.length > 0) {
      console.error(`\n${drifted.length} file(s) drifted. Run with --bump <semver> to sync.`);
      process.exit(1);
    }
    console.log("\nrelease-sync: in sync.");
    process.exit(0);
  }
  // --bump path
  const result = bumpManifestVersion(args.bump);
  const touched = applySync();
  console.log(`\nrelease-sync: synced ${touched} files; plugin/composer-mastermind/plugin.json ${result.from} → ${result.to}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`release-sync: ${err.message}`);
    process.exit(1);
  }
}
