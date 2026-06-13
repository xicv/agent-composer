import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { computeReviewDiff } from "../../src/util/reviewDiff.js";

function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return result.status === 0 && !result.error;
}

function gitExec(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? ""}`);
  }
}

describe("computeReviewDiff", () => {
  let root: string;

  beforeEach(() => {
    if (!gitAvailable()) return;
    root = mkdtempSync(join(tmpdir(), "reviewDiff-test-"));
    gitExec(["init"], root);
    gitExec(["config", "user.email", "test@test.com"], root);
    gitExec(["config", "user.name", "Test"], root);
    // Initial commit so HEAD exists
    writeFileSync(join(root, "file.ts"), "export const a = 1;\n", "utf8");
    gitExec(["add", "file.ts"], root);
    gitExec(["commit", "-m", "init"], root);
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("staged: returns diff for a staged change", () => {
    if (!gitAvailable()) return;
    writeFileSync(join(root, "file.ts"), "export const a = 2;\n", "utf8");
    gitExec(["add", "file.ts"], root);
    const diff = computeReviewDiff(root, "staged");
    expect(diff).toContain("file.ts");
    expect(diff).toContain("+export const a = 2;");
  });

  it("unstaged: returns diff for an unstaged modification", () => {
    if (!gitAvailable()) return;
    writeFileSync(join(root, "file.ts"), "export const a = 99;\n", "utf8");
    // Do NOT stage
    const diff = computeReviewDiff(root, "unstaged");
    expect(diff).toContain("file.ts");
    expect(diff).toContain("+export const a = 99;");
  });

  it("files filter: narrows diff to the given pathspec", () => {
    if (!gitAvailable()) return;
    writeFileSync(join(root, "file.ts"), "export const a = 3;\n", "utf8");
    writeFileSync(join(root, "other.ts"), "export const b = 3;\n", "utf8");
    gitExec(["add", "file.ts", "other.ts"], root);
    const diff = computeReviewDiff(root, "staged", { files: ["file.ts"] });
    expect(diff).toContain("file.ts");
    expect(diff).not.toContain("other.ts");
  });

  it("empty scope throws with /no changes/ message", () => {
    if (!gitAvailable()) return;
    // Nothing staged
    expect(() => computeReviewDiff(root, "staged")).toThrow(/no changes/);
  });

  it("working-tree: returns diff against HEAD for unstaged + staged changes", () => {
    if (!gitAvailable()) return;
    writeFileSync(join(root, "file.ts"), "export const a = 42;\n", "utf8");
    // Do NOT stage — working-tree uses HEAD
    const diff = computeReviewDiff(root, "working-tree");
    expect(diff).toContain("file.ts");
    expect(diff).toContain("+export const a = 42;");
  });
});
