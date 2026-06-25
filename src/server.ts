// Wave 1 F2.1 — factory for the Composer MCP server (per §8 Day 1).
// Pure function: takes a ProviderRegistry, returns an unconnected McpServer
// with the three C0.3 tools registered. Test code connects via
// InMemoryTransport; src/index.ts connects via StdioServerTransport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import type { ProviderRegistry } from "./registry.js";
import type { ComposerConfig } from "./config/schema.js";
import { loadConfig as loadComposerConfig } from "./config/loader.js";
import { resolveEffectiveConfig } from "./config/profiles.js";
import type { ComposerServerOptions, SessionOverrides } from "./tools/context.js";
import { registerResearchTools } from "./tools/research.js";
import { registerCodeTools } from "./tools/code.js";
import { registerReviewTools } from "./tools/review.js";
import { registerOracleTools } from "./tools/oracle.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerCodexLifecycleTools } from "./tools/codexLifecycle.js";
import { registerConfigTools } from "./tools/config.js";
import { registerRouteTools } from "./tools/route.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerStatusTools } from "./tools/status.js";
import { registerSessionTools } from "./tools/session.js";
import { registerGoalTools } from "./tools/goal.js";
import { createActiveRunTracker } from "./server/activeRuns.js";

export * from "./server/toolDescriptions.js";
export type { ComposerServerOptions } from "./tools/context.js";

export interface ConfigRefreshState {
  lastConfigMtimeMs?: number;
}

export interface ConfigRefreshOptions {
  configPath?: string;
  registry: Pick<ProviderRegistry, "setConfig">;
  getActiveConfig: () => ComposerConfig | undefined;
  setActiveConfig: (config: ComposerConfig | undefined) => void;
  state: ConfigRefreshState;
  statSync?: (path: string) => Pick<fs.Stats, "mtimeMs">;
  loadConfig?: (path: string) => ComposerConfig;
  log?: (message: string) => void;
}

export function refreshConfigIfChanged({
  configPath,
  registry,
  getActiveConfig,
  setActiveConfig,
  state,
  statSync = fs.statSync,
  loadConfig = loadComposerConfig,
  log = (message) => process.stderr.write(`${message}\n`),
}: ConfigRefreshOptions): void {
  if (!configPath) return;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`composer config hot-reload skipped: failed to stat ${configPath}: ${detail}`);
    return;
  }
  if (
    state.lastConfigMtimeMs !== undefined &&
    mtimeMs <= state.lastConfigMtimeMs
  ) {
    return;
  }
  try {
    const nextConfig = loadConfig(configPath);
    if (nextConfig === getActiveConfig()) {
      state.lastConfigMtimeMs = mtimeMs;
      return;
    }
    setActiveConfig(nextConfig);
    registry.setConfig(resolveEffectiveConfig(nextConfig).config);
    state.lastConfigMtimeMs = mtimeMs;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`composer config hot-reload skipped: failed to load ${configPath}: ${detail}`);
  }
}

export function createComposerServer(
  registry: ProviderRegistry,
  options: ComposerServerOptions = {},
): McpServer {
  const root = path.resolve(options.root ?? process.cwd());
  let activeConfig: ComposerConfig | undefined = options.config;
  let activeEffectiveFallbacks = activeConfig
    ? resolveEffectiveConfig(activeConfig).effectiveFallbacks
    : {};
  const applyActiveConfig = (c: ComposerConfig | undefined) => {
    activeConfig = c;
    activeEffectiveFallbacks = c ? resolveEffectiveConfig(c).effectiveFallbacks : {};
  };
  const configRefreshState: ConfigRefreshState = {};
  let session: SessionOverrides = {};
  const activeRuns = createActiveRunTracker();
  const server = new McpServer({
    name: "composer",
    version: "0.0.0",
  });

  // Per advisor pass 2026-05-23: tool annotations signal behaviour to the
  // orchestrator without changing execution. readOnlyHint / openWorldHint /
  // destructiveHint / idempotentHint are append-only per ADR 0001.

  const ctx = {
    server,
    registry,
    root,
    options,
    getActiveConfig: () => activeConfig,
    setActiveConfig: applyActiveConfig,
    refreshConfigIfChanged: () => {
      refreshConfigIfChanged({
        configPath: options.configPath,
        registry,
        getActiveConfig: () => activeConfig,
        setActiveConfig: applyActiveConfig,
        state: configRefreshState,
      });
    },
    getEffectiveFallbacks: () => ({ ...activeEffectiveFallbacks }),
    getSession: () => ({ ...session, ...(session.oracle ? { oracle: { ...session.oracle } } : {}) }),
    setSession: (patch: Partial<SessionOverrides>) => {
      session = {
        ...session,
        ...patch,
        ...(patch.oracle ? { oracle: { ...session.oracle, ...patch.oracle } } : {}),
      };
      return { ...session, ...(session.oracle ? { oracle: { ...session.oracle } } : {}) };
    },
    resetSession: () => { session = {}; },
    activeRuns,
  };

  registerResearchTools(ctx);
  registerCodeTools(ctx);
  registerReviewTools(ctx);
  registerOracleTools(ctx);
  registerHandoffTools(ctx);
  registerCodexLifecycleTools(ctx);
  registerConfigTools(ctx);
  registerRouteTools(ctx);
  registerAuditTools(ctx);
  registerSessionTools(ctx);
  registerWorkflowTools(ctx);
  registerGoalTools(ctx);
  registerStatusTools(ctx);

  return server;
}
