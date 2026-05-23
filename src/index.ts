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

const CONFIG_PATH = process.env["COMPOSER_CONFIG"] ?? "composer.config.json";
const ENV_PATH = process.env["COMPOSER_ENV"] ?? ".env.json";

async function main(): Promise<void> {
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
