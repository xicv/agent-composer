import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProviderRegistry } from "../registry.js";
import type { ComposerConfig } from "../config/schema.js";
import type { ActiveRunTracker } from "../server/activeRuns.js";

export interface ComposerServerOptions {
  root?: string;
  config?: ComposerConfig;
  configPath?: string;
}

export interface SessionOverrides {
  mode?: "fast" | "balanced" | "strict";
  oracle?: {
    enabled?: boolean;
    defaultMode?: "auto" | "quick" | "standard" | "deep" | "plan" | "review" | "debug" | "research";
    requireExplicitTag?: boolean;
  };
  profile?: string;
}

export interface ServerToolContext {
  server: McpServer;
  registry: ProviderRegistry;
  root: string;
  options: ComposerServerOptions;
  getActiveConfig: () => ComposerConfig | undefined;
  setActiveConfig: (config: ComposerConfig | undefined) => void;
  refreshConfigIfChanged: () => void;
  getSession: () => SessionOverrides;
  setSession: (patch: Partial<SessionOverrides>) => SessionOverrides;
  resetSession: () => void;
  activeRuns: ActiveRunTracker;
}
