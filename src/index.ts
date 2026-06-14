#!/usr/bin/env node
// Wave 1 F2.1 — runtime entry point. Loads composer.config.json, wires the
// registry, and serves the composer_* MCP tools over stdio.
//
// Override config path via COMPOSER_CONFIG env var.
// Errors at startup → exit 1 (fail-fast, instead of crashing mid-request).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/loader.js";
import { applyEnvJson } from "./config/env.js";
import { ProviderRegistry } from "./registry.js";
import { createComposerServer } from "./server.js";
import { runInit, runGlobalInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { resolveInitInvocation } from "./cli/initArgs.js";
import { formatHelp } from "./cli/help.js";
import { parseCleanupArgs, runCleanup } from "./cli/cleanup.js";
import { applyMode } from "./cli/mode.js";
import { isModeName, MODE_NAMES } from "./config/modes.js";
import { runStatus } from "./cli/status.js";
import { runInstallGitHook } from "./cli/installGitHook.js";
import { runGoal } from "./cli/goal.js";

const CONFIG_PATH = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
// Pass undefined when COMPOSER_ENV is unset so loadEnvJson uses the lookup
// chain (cwd → ~/.config/composer/). Passing ".env.json" as a literal explicit
// path makes loadEnvJson skip the global fallback — broke running
// agent-composer from any cwd that lacks a local .env.json (manifested as
// "missing ANTHROPIC_AUTH_TOKEN" from composer_code).
const ENV_PATH = process.env["COMPOSER_ENV"];

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(`${formatHelp()}\n`);
    return;
  }
  if (subcommand === "init") {
    const invocation = resolveInitInvocation(process.argv.slice(3));
    if (invocation.kind === "error") {
      process.stderr.write(`${invocation.message}\n`);
      process.exit(2);
      return;
    }
    if (invocation.kind === "global") {
      runGlobalInit({});
    } else {
      runInit({ cwd: process.cwd(), installOracle: invocation.installOracle });
    }
    return;
  }
  if (subcommand === "doctor") {
    const flags = process.argv.slice(3);
    const json = flags.includes("--json");
    const report = await runDoctor({ cwd: process.cwd(), verbose: !json });
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    process.exit(report.healthy ? 0 : 1);
    return;
  }
  if (subcommand === "cleanup") {
    const parsed = parseCleanupArgs(process.argv.slice(3));
    if ("error" in parsed) {
      process.stderr.write(`${parsed.error}\n`);
      process.exit(2);
      return;
    }
    runCleanup(parsed);
    return;
  }
  if (subcommand === "status") {
    const flags = process.argv.slice(3);
    runStatus(process.cwd(), {
      json: flags.includes("--json"),
      line: flags.includes("--line"),
      watch: flags.includes("--watch"),
      replace: flags.includes("--replace"),
    });
    return;
  }
  if (subcommand === "install-git-hook") {
    runInstallGitHook(process.cwd());
    return;
  }
  if (subcommand === "goal") {
    runGoal(process.cwd(), {
      action: process.argv[3],
      flags: process.argv.slice(4),
    });
    return;
  }
  if (subcommand === "mode") {
    const name = process.argv[3];
    if (!name || !isModeName(name)) {
      process.stderr.write(`composer mode: expected one of ${MODE_NAMES.join("|")} (got ${name ?? "nothing"})\n`);
      process.exit(2);
      return;
    }
    const result = applyMode(process.cwd(), name);
    process.stdout.write(`composer mode: ${name} ${result.changed ? "applied to" : "already set in"} ${result.path}\n`);
    return;
  }

  applyEnvJson(ENV_PATH);
  const config = loadConfig(CONFIG_PATH);
  const registry = new ProviderRegistry(config);
  const server = createComposerServer(registry, { config, configPath: CONFIG_PATH });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connection success message goes to stderr — stdio MCP requires stdout
  // for the protocol itself.
  process.stderr.write(
    `composer MCP server connected (stdio) — config: ${CONFIG_PATH}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`composer MCP server startup failed: ${msg}\n`);
  process.exit(1);
});
