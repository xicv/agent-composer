// Wave 1 F2.1 — factory for the Composer MCP server (per §8 Day 1).
// Pure function: takes a ProviderRegistry, returns an unconnected McpServer
// with the three C0.3 tools registered. Test code connects via
// InMemoryTransport; src/index.ts connects via StdioServerTransport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { ProviderRegistry } from "./registry.js";
import {
  HANDOFF_DIR,
  formatHandoffForPrompt,
  newHandoffPacket,
  readHandoffPacket,
  writeHandoffPacket,
  type HandoffArtifact,
} from "./util/handoff.js";

// C0.3 — locked MCP tool names. Referenced by subagent allowlists +
// boundary_guard.sh; do not rename without a new ADR.
export const COMPOSER_RESEARCH = "composer_research" as const;
export const COMPOSER_CODE = "composer_code" as const;
export const COMPOSER_REVIEW = "composer_review" as const;
export const COMPOSER_REVIEW_CLAUDE = "composer_review_claude" as const;
export const COMPOSER_CODE_CLI = "composer_code_cli" as const;
export const COMPOSER_CODE_CHAIN = "composer_code_chain" as const;
export const COMPOSER_HANDOFF_CREATE = "composer_handoff_create" as const;

const RESEARCH_DESCRIPTION =
  "MANDATORY for ALL research, documentation lookup, web search, and " +
  "context gathering. The orchestrator MUST delegate research questions " +
  "to this tool. Do not search or hypothesise in the main session.";

const CODE_DESCRIPTION =
  "MANDATORY for ALL code writing, refactoring, debugging, and " +
  "implementation. The orchestrator MUST delegate implementation to this " +
  "tool. Do not write code in the main session.";

const CODE_CHAIN_DESCRIPTION =
  "Preferred for substantial code: GLM AUTHORS the code (off-CC), then the " +
  "Composer server APPLIES it to disk deterministically (off-CC), then gate it through " +
  "composer_review. The orchestrator only calls this once and relays the " +
  "summary — it never generates or writes code itself. Combines GLM code " +
  "quality with off-CC application (keeps the main session lean). Returns a " +
  "summary of files written.";

const CODE_CLI_DESCRIPTION =
  "Generate AND APPLY code changes directly to disk via the CLI executor " +
  "(Codex/agy/Gemini), which runs in the server working directory and edits files " +
  "itself. Returns ONLY a summary of what changed. Use this to offload BOTH " +
  "generation and file-writing off the main session: the orchestrator does " +
  "NOT call Edit/Write — the executor already applied the changes. Prefer " +
  "this for multi-file or substantial edits to keep the main context lean.";

const REVIEW_DESCRIPTION =
  "MANDATORY for ALL code review, diff critique, and finding bugs in " +
  "candidate patches. The orchestrator MUST delegate review to this tool " +
  "before integrating worker output.";

const REVIEW_CLAUDE_DESCRIPTION =
  "Premium Claude review lane for high-risk diffs, security-sensitive changes, " +
  "or when the user explicitly asks for Claude review. Keep composer_review " +
  "as the default gate; use this as a second-opinion escalation.";

const HANDOFF_CREATE_DESCRIPTION =
  "Create a shared, provider-neutral handoff packet under .composer/handoffs. " +
  "Use this before multi-agent or multi-provider work so Codex, GLM, agy, " +
  "and reviewers receive the same compact objective, constraints, files, " +
  "decisions, and acceptance criteria without copying the full transcript.";

/**
 * Deterministically apply GLM-authored output of the form
 *   FILE: <relative/path>
 *   ```lang
 *   <content>
 *   ```
 * Writes each file under `root` (cwd). Guards against path traversal.
 */
export function applyFileBlocks(
  text: string,
  root: string,
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const re = /FILE:\s*(\S+)[^\n]*\n```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rel = (m[1] ?? "").trim();
    const content = m[2] ?? "";
    if (!rel) continue;
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push(rel + " (outside root)");
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return { written, skipped };
}

export interface ComposerServerOptions {
  root?: string;
}

export function createComposerServer(
  registry: ProviderRegistry,
  options: ComposerServerOptions = {},
): McpServer {
  const root = path.resolve(options.root ?? process.cwd());
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
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Research",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }) => {
      const provider = registry.getProviderForRole("researcher");
      const result = await provider.execute({
        prompt,
        context: contextWithHandoff(root, context, handoffPath),
      });
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
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Code",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }) => {
      const provider = registry.getProviderForRole("coder");
      const result = await provider.execute({
        prompt,
        context: contextWithHandoff(root, context, handoffPath),
      });
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
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Review",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath }) => {
      const provider = registry.getProviderForRole("reviewer");
      const result = await provider.execute({
        prompt,
        context: contextWithHandoff(root, diff, handoffPath),
      });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_REVIEW_CLAUDE,
    {
      description: REVIEW_CLAUDE_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        diff: z.string().min(1),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Review (Claude Premium)",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ prompt, diff, handoffPath }) => {
      const provider = registry.getProviderForRole("reviewerClaude");
      const result = await provider.execute({
        prompt,
        context: contextWithHandoff(root, diff, handoffPath),
        cwd: root,
      });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CHAIN,
    {
      description: CODE_CHAIN_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (GLM author -> CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }) => {
      // Stage 1: GLM authors the code off-CC (returns full file contents).
      const gen = registry.getProviderForRole("coder");
      const genPrompt =
        prompt +
        "\n\nOUTPUT FORMAT: give the COMPLETE contents of every file to " +
        "create or modify. For each file, write a line `FILE: <relative/path>` " +
        "followed by a fenced code block with the full file content. No " +
        "abbreviations, no placeholders, no commentary outside the blocks.";
      const authored = await gen.execute({
        prompt: genPrompt,
        context: contextWithHandoff(root, context, handoffPath),
      });

      // Stage 2: server applies GLM's FILE: blocks deterministically (off-CC,
      // no LLM transcription step — an executor cannot fabricate the apply).
      const { written, skipped } = applyFileBlocks(authored.text, root);
      const summary =
        written.length > 0
          ? `GLM authored + applied off-CC. Wrote ${written.length} file(s): ${written.join(", ")}.` +
            (skipped.length ? ` Skipped: ${skipped.join(", ")}.` : "")
          : "GLM authored but produced NO parseable FILE: blocks — nothing written. " +
            "Re-issue with explicit 'FILE: <path>' + fenced-block formatting, or " +
            "use composer_code_cli (CLI executor authors+applies) instead.";
      return { content: [{ type: "text", text: summary }] };
    },
  );

  server.registerTool(
    COMPOSER_CODE_CLI,
    {
      description: CODE_CLI_DESCRIPTION,
      inputSchema: {
        prompt: z.string().min(1),
        context: z.string().optional(),
        handoffPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Code (CLI apply)",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ prompt, context, handoffPath }) => {
      const provider = registry.getProviderForRole("coderCli");
      const result = await provider.execute({
        prompt,
        context: contextWithHandoff(root, context, handoffPath),
        cwd: root,
      });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    COMPOSER_HANDOFF_CREATE,
    {
      description: HANDOFF_CREATE_DESCRIPTION,
      inputSchema: {
        objective: z.string().min(1),
        contextSummary: z.string().optional(),
        constraints: z.array(z.string().min(1)).optional(),
        relevantFiles: z.array(z.string().min(1)).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        decisions: z.array(z.string().min(1)).optional(),
        openQuestions: z.array(z.string().min(1)).optional(),
        artifacts: z
          .array(
            z.object({
              kind: z.enum(["research", "code", "review", "test", "note"]),
              summary: z.string().min(1),
              path: z.string().min(1).optional(),
              source: z.string().min(1).optional(),
            }),
          )
          .optional(),
        briefPath: z.string().optional(),
      },
      annotations: {
        title: "Composer Handoff Create",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({
      objective,
      contextSummary,
      constraints,
      relevantFiles,
      acceptanceCriteria,
      decisions,
      openQuestions,
      artifacts,
      briefPath,
    }) => {
      const packet = newHandoffPacket({
        objective,
        contextSummary,
        constraints,
        relevantFiles,
        acceptanceCriteria,
        decisions,
        openQuestions,
        artifacts: artifacts as HandoffArtifact[] | undefined,
        briefPath,
      });
      const handoffPath = writeHandoffPacket(
        packet,
        path.resolve(root, HANDOFF_DIR),
      );
      const response = {
        runId: packet.runId,
        handoffPath,
        objective: packet.objective,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  return server;
}

function contextWithHandoff(
  root: string,
  context?: string,
  handoffPath?: string,
): string | undefined {
  const blocks: string[] = [];
  if (handoffPath) {
    const handoff = readHandoffPacket(handoffPath, root);
    blocks.push(formatHandoffForPrompt(handoff));
  }
  if (context) blocks.push(context);
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
