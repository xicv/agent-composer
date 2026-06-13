import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProviderRegistry } from "../registry.js";
import type { ComposerConfig } from "../config/schema.js";

export interface ComposerServerOptions {
  root?: string;
  config?: ComposerConfig;
  configPath?: string;
}

export interface ServerToolContext {
  server: McpServer;
  registry: ProviderRegistry;
  root: string;
  options: ComposerServerOptions;
  getActiveConfig: () => ComposerConfig | undefined;
  setActiveConfig: (config: ComposerConfig | undefined) => void;
}
