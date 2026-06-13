import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isComposerDisabled } from "../../src/util/composerDisabled.js";

describe("isComposerDisabled", () => {
  const saved: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      saved[k] = process.env[k];
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Reset saved map for next test
    for (const k of Object.keys(saved)) {
      delete saved[k];
    }
  });

  it("returns false by default (no env vars, no files)", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED", "COMPOSER_DISABLED_FILE", "CLAUDE_PROJECT_DIR", "HOME");
    delete process.env["COMPOSER_ENABLED"];
    delete process.env["COMPOSER_DISABLED"];
    delete process.env["COMPOSER_DISABLED_FILE"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    // Use a temp dir as HOME that has no .claude/composer.disabled
    const fakeHome = mkdtempSync(join(tmpdir(), "composer-disabled-home-"));
    process.env["HOME"] = fakeHome;
    try {
      expect(isComposerDisabled()).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns true when COMPOSER_ENABLED=0", () => {
    saveEnv("COMPOSER_ENABLED");
    process.env["COMPOSER_ENABLED"] = "0";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_ENABLED=false", () => {
    saveEnv("COMPOSER_ENABLED");
    process.env["COMPOSER_ENABLED"] = "false";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_ENABLED=off", () => {
    saveEnv("COMPOSER_ENABLED");
    process.env["COMPOSER_ENABLED"] = "off";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_ENABLED=no", () => {
    saveEnv("COMPOSER_ENABLED");
    process.env["COMPOSER_ENABLED"] = "no";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_ENABLED=FALSE", () => {
    saveEnv("COMPOSER_ENABLED");
    process.env["COMPOSER_ENABLED"] = "FALSE";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_DISABLED=1", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED");
    delete process.env["COMPOSER_ENABLED"];
    process.env["COMPOSER_DISABLED"] = "1";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_DISABLED=true", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED");
    delete process.env["COMPOSER_ENABLED"];
    process.env["COMPOSER_DISABLED"] = "true";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_DISABLED=on", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED");
    delete process.env["COMPOSER_ENABLED"];
    process.env["COMPOSER_DISABLED"] = "on";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_DISABLED=yes", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED");
    delete process.env["COMPOSER_ENABLED"];
    process.env["COMPOSER_DISABLED"] = "yes";
    expect(isComposerDisabled()).toBe(true);
  });

  it("returns true when COMPOSER_DISABLED_FILE points to an existing file", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED", "COMPOSER_DISABLED_FILE");
    delete process.env["COMPOSER_ENABLED"];
    delete process.env["COMPOSER_DISABLED"];
    const tmp = mkdtempSync(join(tmpdir(), "composer-disabled-file-"));
    const flagFile = join(tmp, "disabled.flag");
    writeFileSync(flagFile, "", "utf8");
    process.env["COMPOSER_DISABLED_FILE"] = flagFile;
    try {
      expect(isComposerDisabled()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns true when <projectDir>/.composer-disabled exists", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED", "COMPOSER_DISABLED_FILE", "CLAUDE_PROJECT_DIR");
    delete process.env["COMPOSER_ENABLED"];
    delete process.env["COMPOSER_DISABLED"];
    delete process.env["COMPOSER_DISABLED_FILE"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    const projDir = mkdtempSync(join(tmpdir(), "composer-disabled-proj-"));
    writeFileSync(join(projDir, ".composer-disabled"), "", "utf8");
    try {
      expect(isComposerDisabled({ projectDir: projDir })).toBe(true);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("returns true when $HOME/.claude/composer.disabled exists", () => {
    saveEnv("COMPOSER_ENABLED", "COMPOSER_DISABLED", "COMPOSER_DISABLED_FILE", "CLAUDE_PROJECT_DIR", "HOME");
    delete process.env["COMPOSER_ENABLED"];
    delete process.env["COMPOSER_DISABLED"];
    delete process.env["COMPOSER_DISABLED_FILE"];
    delete process.env["CLAUDE_PROJECT_DIR"];
    const fakeHome = mkdtempSync(join(tmpdir(), "composer-disabled-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "composer.disabled"), "", "utf8");
    process.env["HOME"] = fakeHome;
    try {
      expect(isComposerDisabled()).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
