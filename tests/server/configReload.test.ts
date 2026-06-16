import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../../src/config/loader.js";
import { refreshConfigIfChanged } from "../../src/server.js";
import type { ComposerConfig } from "../../src/config/schema.js";

function configJson(coderCliTimeoutMs: number): string {
  return `${JSON.stringify(
    {
      roles: {
        researcher: { provider: "mock" },
        coder: { provider: "mock" },
        reviewer: { provider: "mock" },
        coderCli: {
          provider: "cli",
          cli: ["node", "-e", "process.stdout.write('ok')"],
          timeoutMs: coderCliTimeoutMs,
        },
      },
    },
    null,
    2,
  )}\n`;
}

function parsedConfig(coderCliTimeoutMs: number): ComposerConfig {
  return parseConfig(JSON.parse(configJson(coderCliTimeoutMs)));
}

function bumpFile(path: string, contents: string, seconds: number): void {
  writeFileSync(path, contents);
  const when = new Date(seconds * 1000);
  utimesSync(path, when, when);
}

describe("refreshConfigIfChanged", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("loads on first call, skips unchanged files, and reloads when mtime increases", () => {
    tempDir = mkdtempSync(join(tmpdir(), "composer-config-reload-"));
    const configPath = join(tempDir, "composer.config.json");
    bumpFile(configPath, configJson(1000), 100);
    let activeConfig: ComposerConfig | undefined;
    const registry = { setConfig: vi.fn() };
    const state = {};
    const statSync = vi.fn((path: string) => fs.statSync(path));
    const countedLoadConfig = vi.fn((path: string) => loadConfig(path));

    refreshConfigIfChanged({
      configPath,
      registry,
      getActiveConfig: () => activeConfig,
      setActiveConfig: (config) => {
        activeConfig = config;
      },
      state,
      statSync,
      loadConfig: countedLoadConfig,
    });

    expect(activeConfig?.roles.coderCli?.timeoutMs).toBe(1000);
    expect(registry.setConfig).toHaveBeenCalledTimes(1);
    expect(countedLoadConfig).toHaveBeenCalledTimes(1);
    expect(statSync).toHaveBeenCalledTimes(1);

    refreshConfigIfChanged({
      configPath,
      registry,
      getActiveConfig: () => activeConfig,
      setActiveConfig: (config) => {
        activeConfig = config;
      },
      state,
      statSync,
      loadConfig: countedLoadConfig,
    });

    expect(countedLoadConfig).toHaveBeenCalledTimes(1);
    expect(statSync).toHaveBeenCalledTimes(2);

    bumpFile(configPath, configJson(10), 200);
    refreshConfigIfChanged({
      configPath,
      registry,
      getActiveConfig: () => activeConfig,
      setActiveConfig: (config) => {
        activeConfig = config;
      },
      state,
      statSync,
      loadConfig: countedLoadConfig,
    });

    expect(activeConfig?.roles.coderCli?.timeoutMs).toBe(10);
    expect(registry.setConfig).toHaveBeenCalledTimes(2);
    expect(countedLoadConfig).toHaveBeenCalledTimes(2);
    expect(statSync).toHaveBeenCalledTimes(3);
  });

  it("keeps the prior active config when a changed file is malformed", () => {
    tempDir = mkdtempSync(join(tmpdir(), "composer-config-reload-"));
    const configPath = join(tempDir, "composer.config.json");
    bumpFile(configPath, configJson(1000), 100);
    let activeConfig: ComposerConfig | undefined = parsedConfig(1000);
    const registry = { setConfig: vi.fn() };
    const state = {};
    const log = vi.fn();

    refreshConfigIfChanged({
      configPath,
      registry,
      getActiveConfig: () => activeConfig,
      setActiveConfig: (config) => {
        activeConfig = config;
      },
      state,
      log,
    });
    expect(registry.setConfig).toHaveBeenCalledTimes(1);

    bumpFile(configPath, "{", 200);
    expect(() =>
      refreshConfigIfChanged({
        configPath,
        registry,
        getActiveConfig: () => activeConfig,
        setActiveConfig: (config) => {
          activeConfig = config;
        },
        state,
        log,
      }),
    ).not.toThrow();

    expect(activeConfig?.roles.coderCli?.timeoutMs).toBe(1000);
    expect(registry.setConfig).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledOnce();
  });
});
