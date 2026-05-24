import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalConfigDir, resolveConfigPath } from "../../src/config/paths.js";

describe("paths.globalConfigDir", () => {
  let savedXdg: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedXdg = process.env["XDG_CONFIG_HOME"];
    savedHome = process.env["HOME"];
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = savedXdg;
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  });

  it("honours XDG_CONFIG_HOME if set", () => {
    process.env["XDG_CONFIG_HOME"] = "/some/xdg/path";
    expect(globalConfigDir()).toBe("/some/xdg/path/composer");
  });

  it("falls back to $HOME/.config/composer when XDG_CONFIG_HOME unset", () => {
    delete process.env["XDG_CONFIG_HOME"];
    process.env["HOME"] = "/Users/test";
    expect(globalConfigDir()).toBe("/Users/test/.config/composer");
  });
});

describe("paths.resolveConfigPath", () => {
  let tmp: string;
  let savedCwd: string;
  let savedXdg: string | undefined;

  beforeEach(() => {
    // realpathSync resolves macOS's /var → /private/var symlink so test paths
    // match process.cwd() after chdir (process.cwd returns the canonical form).
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "composer-paths-test-")));
    savedCwd = process.cwd();
    savedXdg = process.env["XDG_CONFIG_HOME"];
    // Sandbox XDG so resolveConfigPath cannot reach the developer's real ~/.config
    process.env["XDG_CONFIG_HOME"] = join(tmp, "xdg");
  });
  afterEach(() => {
    process.chdir(savedCwd);
    if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = savedXdg;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no file exists in any layer", () => {
    process.chdir(tmp);
    expect(resolveConfigPath("nonexistent.json")).toBeNull();
  });

  it("returns explicit path when it exists", () => {
    const explicit = join(tmp, "explicit.json");
    writeFileSync(explicit, "{}");
    process.chdir(tmp);
    expect(resolveConfigPath("nonexistent.json", explicit)).toBe(resolve(explicit));
  });

  it("ignores explicit path when it does not exist; falls back to cwd file if present", () => {
    process.chdir(tmp);
    const local = join(tmp, "x.json");
    writeFileSync(local, "{}");
    expect(resolveConfigPath("x.json", "/nope/missing.json")).toBe(resolve(local));
  });

  it("falls back to global config dir when cwd has no file", () => {
    const globalDir = join(tmp, "xdg", "composer");
    mkdirSync(globalDir, { recursive: true });
    const globalFile = join(globalDir, "x.json");
    writeFileSync(globalFile, "{}");
    process.chdir(tmp);
    expect(resolveConfigPath("x.json")).toBe(globalFile);
  });

  it("project-level file takes priority over global file", () => {
    const globalDir = join(tmp, "xdg", "composer");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "x.json"), '{"src":"global"}');
    const localFile = join(tmp, "x.json");
    writeFileSync(localFile, '{"src":"local"}');
    process.chdir(tmp);
    expect(resolveConfigPath("x.json")).toBe(resolve(localFile));
  });
});
