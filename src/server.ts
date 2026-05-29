// Wave 1 F2.1 — factory for the Composer MCP server (per §8 Day 1).
// Pure function: takes a ProviderRegistry, returns an unconnected McpServer
// with the three C0.3 tools registered. Test code connects via
// InMemoryTransport; src/index.ts connects via StdioServerTransport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderRegistry } from "./registry.js";

// C0.3 — locked MCP tool names. Referenced by subagent allowlists +
// boundary_guard.sh; do not rename without a new ADR.
export const COMPOSER_RESEARCH = "composer_research" as const;
export const COMPOSER_CODE = "composer_code" as const;
export const COMPOSER_REVIEW = "composer_review" as const;
export const COMPOSER_CODE_CLI = "composer_code_cli" as const;

const RESEARCH_DESCRIPTION =
  "MANDATORY for ALL research, documentation lookup, web search, and " +
  "context gathering. The orchestrator MUST delegate research questions " +
  "to this tool. Do not search or hypothesise in the main session.";

const CODE_DESCRIPTION =
  "MANDATORY for ALL code writing, refactoring, debugging, and " +
  "implementation. The orchestrator MUST delegate implementation to this " +
  "tool. Do not write code in the main session.";

const CODE_CLI_DESCRIPTION =
  "Generate AND APPLY code changes directly to disk via the CLI executor " +
  "(agy/Gemini), which runs in the server working directory and edits files " +
  "itself. Returns ONLY a summary of what changed. Use this to offload BOTH " +
  "generation and file-writing off the main session: the orchestrator does " +
  "NOT call Edit/Write — the executor already applied the changes. Prefer " +
  "this for multi-file or substantial edits to keep the main context lean.";

const REVIEW_DESCRIPTION =
  "MANDATORY for ALL code review, diff critique, and finding bugs in " +
  "candidate patches. The orchestrator MUST delegate review to this tool " +
  "before integrating worker output.";

export function createComposerServer(registry: ProviderRegistry): McpServer {
  const server = new McpServer({
    name: "composer",
    version: "0.0.0",
  });

  // Per advisor pass 2026-05-23: tool annotations signal behaviour to the
  // orchestrator without changing execution. readOnlyHint / openWorldHint /
  // destructiveHint / idempotentHint are append-only per ADR 0001.

  server.registerTool(
    COMPOSER_RESEARCH,
    {
      description: RESEARCH_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
      },
      annotations: {
        title: "Composer Research",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context }) => {
      const provider = registry.getProviderForRole("researcher");
      const result = await provider.execute({ prompt, context });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE,
    {
      description: CODE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
      },
      annotations: {
        title: "Composer Code",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context }) => {
      const provider = registry.getProviderForRole("coder");
      const result = await provider.execute({ prompt, context });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW,
    {
      description: REVIEW_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1),
      },
      annotations: {
        title: "Composer Review",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff }) => {
      const provider = registry.getProviderForRole("reviewer");
      const result = await provider.execute({ prompt, context: diff });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CLI,
    {
      description: CODE_CLI_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context }) => {
      const provider = registry.getProviderForRole("coderCli");
      const result = await provider.execute({ prompt, context });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  return server;
}
