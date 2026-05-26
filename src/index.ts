#!/usr/bin/env node
// Wave 1 F2.1 — runtime entry point. Loads composer.config.json, wires the
// registry, and serves the three composer_* MCP tools over stdio.
//
// Override config path via COMPOSER_CONFIG env var.
// Errors at startup → exit 1 (fail-fast, instead of crashing mid-request).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/loader.js";
import { applyEnvJson } from "./config/env.js";
import { ProviderRegistry } from "./registry.js";
import { createComposerServer } from "./server.js";
import { runInit, runGlobalInit } from "./cli/init.js";

const CONFIG_PATH = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
// Pass undefined when COMPOSER_ENV is unset so loadEnvJson uses the lookup
// chain (cwd → ~/.config/composer/). Passing ".env.json" as a literal explicit
// path makes loadEnvJson skip the global fallback — broke running
// agent-composer from any cwd that lacks a local .env.json (manifested as
// "missing ANTHROPIC_AUTH_TOKEN" from composer_code).
const ENV_PATH = process.env["COMPOSER_ENV"];

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const flag = process.argv[3];
  if (subcommand === "init") {
    if (flag === "--global") {
      runGlobalInit({});
    } else {
      runInit({ cwd: process.cwd() });
    }
    return;
  }

  applyEnvJson(ENV_PATH);
  const config = loadConfig(CONFIG_PATH);
  const registry = new ProviderRegistry(config);
  const server = createComposerServer(registry);
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
