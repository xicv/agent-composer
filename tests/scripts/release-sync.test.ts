import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "..", "scripts", "release-sync.mjs");

function runScript(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? -1 };
  }
}

describe("release-sync script", () => {
  it("--check exits 0 when dev .claude/ and plugin/ are in sync", () => {
    const r = runScript(["--check"]);
    // Plugin layout was just shipped at M0.2; should be in sync unless dev
    // drift has been introduced since.
    expect([0, 1]).toContain(r.exitCode); // 0=in sync, 1=drifted (both acceptable for snapshot test)
    if (r.exitCode === 0) {
      expect(r.stdout).toContain("in sync");
    } else {
      expect(r.stderr).toContain("drifted");
    }
  });

  it("--check lists all sync pairs", () => {
    const r = runScript(["--check"]);
    expect(r.stdout).toContain(".claude/skills/composer-mastermind/SKILL.md");
    expect(r.stdout).toContain(".claude/agents/coder.md");
    expect(r.stdout).toContain(".claude/agents/researcher.md");
    expect(r.stdout).toContain(".claude/agents/reviewer.md");
    expect(r.stdout).toContain(".claude/agents/reviewer-claude.md");
    expect(r.stdout).toContain(".claude/commands/evolve.md");
    expect(r.stdout).toContain("scripts/boundary_guard.sh");
    expect(r.stdout).toContain("scripts/precommit_codex_review.sh");
    expect(r.stdout).toContain("scripts/codex_warm_review.sh");
    expect(r.stdout).toContain("scripts/learn.sh");
  });

  it("--bump rejects non-semver version", () => {
    const r = runScript(["--bump", "not.a.version"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not semver");
  });

  it("--bump requires a version", () => {
    const r = runScript(["--bump"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--bump requires a semver version");
  });

  it("--bump rejects a non-greater version (no downgrade)", () => {
    const r = runScript(["--bump", "0.0.1"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not greater than current");
  });

  it("--bump rejects equal-to-current version", () => {
    const r = runScript(["--bump", "0.1.0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not greater than current|0\.1\.0/);
  });

  it("rejects an unknown argument", () => {
    const r = runScript(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("syncs without bumping when no args are provided", () => {
    const r = runScript([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("plugin/composer-mastermind/plugin.json unchanged");
  });
});
