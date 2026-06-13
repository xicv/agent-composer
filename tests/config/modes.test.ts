import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modePatch, isModeName, MODE_NAMES } from "../../src/config/modes.js";
import { applyMode } from "../../src/cli/mode.js";

const MINIMAL_CONFIG = {
  roles: {
    researcher: { provider: "mock" },
    coder: { provider: "mock" },
    reviewer: { provider: "mock" },
  },
};

describe("modePatch", () => {
  it("fast disables lifecycle and review", () => {
    const patch = modePatch("fast");
    expect(patch.codexLifecycle).toEqual({ enabled: false });
    expect(patch.codexReview).toEqual({ enabled: false, preCommitHook: { enabled: false } });
  });

  it("balanced enables lifecycle ask + review fail-open", () => {
    const patch = modePatch("balanced");
    expect(patch.codexLifecycle).toEqual({ enabled: true, mode: "ask" });
    expect(patch.codexReview).toEqual({ enabled: true, preCommitHook: { enabled: true, failClosed: false } });
  });

  it("strict enables lifecycle auto + review fail-closed", () => {
    const patch = modePatch("strict");
    expect(patch.codexLifecycle).toEqual({ enabled: true, mode: "auto" });
    expect(patch.codexReview).toEqual({ enabled: true, preCommitHook: { enabled: true, failClosed: true } });
  });
});

describe("isModeName", () => {
  it("returns true for valid mode names", () => {
    for (const name of MODE_NAMES) {
      expect(isModeName(name)).toBe(true);
    }
  });

  it("returns false for invalid values", () => {
    expect(isModeName("")).toBe(false);
    expect(isModeName("turbo")).toBe(false);
    expect(isModeName("STRICT")).toBe(false);
  });
});

describe("applyMode", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-modes-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "composer.config.json"),
      JSON.stringify(MINIMAL_CONFIG, null, 2) + "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strict: writes failClosed=true and lifecycle mode=auto", () => {
    const result = applyMode(tmpDir, "strict");
    expect(result.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.path, "utf8")) as Record<string, unknown>;
    const review = written["codexReview"] as Record<string, unknown>;
    const hook = review["preCommitHook"] as Record<string, unknown>;
    const lifecycle = written["codexLifecycle"] as Record<string, unknown>;
    expect(hook["failClosed"]).toBe(true);
    expect(lifecycle["mode"]).toBe("auto");
  });

  it("fast: writes codexReview.enabled=false", () => {
    const result = applyMode(tmpDir, "fast");
    expect(result.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.path, "utf8")) as Record<string, unknown>;
    const review = written["codexReview"] as Record<string, unknown>;
    expect(review["enabled"]).toBe(false);
  });

  it("idempotent: applying the same mode twice yields changed=false on the second call", () => {
    applyMode(tmpDir, "balanced");
    const second = applyMode(tmpDir, "balanced");
    expect(second.changed).toBe(false);
  });
});
