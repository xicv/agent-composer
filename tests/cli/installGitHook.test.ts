import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installGitHook } from "../../src/cli/installGitHook.js";

function gitAvailable(): boolean {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function initGitRepo(dir: string): void {
  spawnSync("git", ["init", dir], { encoding: "utf8", timeout: 10000 });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "Test"], { encoding: "utf8" });
}

describe("installGitHook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-install-hook-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(!gitAvailable())("installs the hook in a fresh git repo", () => {
    initGitRepo(tmp);

    const result = installGitHook(tmp);

    expect(result.status).toBe("installed");
    expect(existsSync(result.path)).toBe(true);
  });

  it.skipIf(!gitAvailable())("installed hook file is executable", () => {
    initGitRepo(tmp);

    const result = installGitHook(tmp);

    const stat = statSync(result.path);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it.skipIf(!gitAvailable())("installed hook content includes precommit_codex_review.sh and --git-hook", () => {
    initGitRepo(tmp);

    const result = installGitHook(tmp);

    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("precommit_codex_review.sh");
    expect(content).toContain("--git-hook");
  });

  it.skipIf(!gitAvailable())("second call returns already", () => {
    initGitRepo(tmp);

    installGitHook(tmp);
    const second = installGitHook(tmp);

    expect(second.status).toBe("already");
  });

  it.skipIf(!gitAvailable())("returns refused when a foreign pre-commit hook already exists", () => {
    initGitRepo(tmp);

    const hooksDir = join(tmp, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = installGitHook(tmp);

    expect(result.status).toBe("refused");
    expect(result.reason).toContain("non-Composer pre-commit hook");
  });

  it("throws when cwd is not a git repository", () => {
    // tmp is not a git repo (only created with mkdtemp, no git init)
    expect(() => installGitHook(tmp)).toThrow("install-git-hook: not a git repository");
  });
});
