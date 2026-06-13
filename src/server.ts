// Wave 1 F2.1 — factory for the Composer MCP server (per §8 Day 1).
// Pure function: takes a ProviderRegistry, returns an unconnected McpServer
// with the three C0.3 tools registered. Test code connects via
// InMemoryTransport; src/index.ts connects via StdioServerTransport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import type { ProviderRegistry } from "./registry.js";
import type { ComposerConfig } from "./config/schema.js";
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

export { applyFileBlocks } from "./util/applyFileBlocks.js";
export * from "./server/toolDescriptions.js";
export type { ComposerServerOptions } from "./tools/context.js";

export function createComposerServer(
  registry: ProviderRegistry,
  options: ComposerServerOptions = {},
): McpServer {
  const root = path.resolve(options.root ?? process.cwd());
  let activeConfig: ComposerConfig | undefined = options.config;
  let session: SessionOverrides = {};
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
    setActiveConfig: (c: ComposerConfig | undefined) => {
      activeConfig = c;
    },
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
  registerStatusTools(ctx);

  return server;
}
