import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createComposerServer } from "../../src/server.js";
import { ProviderRegistry } from "../../src/registry.js";
import { parseConfig } from "../../src/config/loader.js";
import type { ComposerConfig } from "../../src/config/schema.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

const allMockConfig: ComposerConfig = parseConfig({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
    reviewerClaude: { provider: "mock", model: "reviewer-claude-mock" },
    coderCli: { provider: "mock", model: "coder-cli-mock" },
  },
});

async function bootClient(root?: string) {
  const registry = new ProviderRegistry(allMockConfig);
  const server = createComposerServer(registry, root ? { root } : {});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "composer-test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, registry };
}

describe("composer MCP server", () => {
  it("registers composer tools with locked and append-only names", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "composer_code",
      "composer_code_chain",
      "composer_code_cli",
      "composer_handoff_create",
      "composer_research",
      "composer_review",
      "composer_review_claude",
    ]);
  });

  it("each tool has a non-empty description", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(0);
    }
  });

  it("marks composer_code as legacy and composer_code_cli as the default coding lane", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName["composer_code"]?.description).toContain("LEGACY");
    expect(byName["composer_code"]?.description).not.toContain("MANDATORY");
    expect(byName["composer_code_cli"]?.description).toContain("Generate AND APPLY");
    expect(byName["composer_code_cli"]?.description).toContain("Prefer");
  });

  it("marks research and review tools as direct bounded off-CC lanes", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName["composer_research"]?.description).toContain("Default off-CC research lane");
    expect(byName["composer_research"]?.description).toContain("bounded summary");
    expect(byName["composer_review"]?.description).toContain("Default off-CC review lane");
    expect(byName["composer_review"]?.description).toContain("bounded summary");
    expect(byName["composer_review_claude"]?.description).toContain("call this directly");
  });

  it("declares correct tool annotations (advisor pass 2026-05-23)", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName["composer_research"]?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(byName["composer_code"]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName["composer_review"]?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName["composer_review_claude"]?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName["composer_handoff_create"]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("composer_research routes to the researcher MockProvider", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_research",
      arguments: { prompt: "find zod docs" },
    });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    expect(block?.type).toBe("text");
    expect(block?.text).toContain("mock:find zod docs");
  });

  it("composer_code routes to the coder MockProvider", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_code",
      arguments: { prompt: "add slugify", context: "src/util" },
    });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    expect(block?.text).toContain("mock:add slugify");
    expect(block?.text).toContain("ctx:src/util");
  });

  it("composer_code_cli routes to the coderCli MockProvider", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_code_cli",
      arguments: { prompt: "apply with codex", context: "src/server.ts" },
    });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    expect(block?.text).toContain("mock:apply with codex");
    expect(block?.text).toContain("ctx:src/server.ts");
  });

  it("composer_code_cli passes the server root as provider cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "composer-mcp-"));
    try {
      const { client, registry } = await bootClient(root);
      await client.callTool({
        name: "composer_code_cli",
        arguments: { prompt: "apply with codex" },
      });
      const provider = registry.getProviderForRole("coderCli");
      expect(provider).toBeInstanceOf(MockProvider);
      expect((provider as MockProvider).calls[0]?.cwd).toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits progress notifications for long-running tool calls when requested", async () => {
    const { client } = await bootClient();
    const progress: Array<{ progress: number; message?: string }> = [];
    await client.callTool(
      {
        name: "composer_code_cli",
        arguments: { prompt: "apply with codex" },
      },
      undefined,
      {
        onprogress: (event) => {
          progress.push(event);
        },
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 60_000,
      },
    );

    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.map((event) => event.message)).toContain("composer_code_cli started");
    expect(progress.map((event) => event.message)).toContain("composer_code_cli completed");
    expect(progress.map((event) => event.progress)).toEqual([1, 2]);
  });

  it("composer_review accepts diff input", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_review",
      arguments: {
        prompt: "scan for bugs",
        diff: "--- a/x\n+++ b/x\n+console.log()",
      },
    });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    expect(block?.text).toContain("mock:scan for bugs");
    expect(block?.text).toContain("console.log()");
  });

  it("composer_review_claude routes to the premium Claude reviewer role", async () => {
    const root = mkdtempSync(join(tmpdir(), "composer-mcp-"));
    try {
      const { client, registry } = await bootClient(root);
      const result = await client.callTool({
        name: "composer_review_claude",
        arguments: {
          prompt: "premium scan for bugs",
          diff: "--- a/x\n+++ b/x\n+console.log()",
        },
      });
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      expect(block?.text).toContain("mock:premium scan for bugs");
      expect(block?.text).toContain("console.log()");
      const provider = registry.getProviderForRole("reviewerClaude");
      expect(provider).toBeInstanceOf(MockProvider);
      expect((provider as MockProvider).calls[0]?.cwd).toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates input — composer_code without prompt returns isError", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_code",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("composer_handoff_create writes a shared handoff packet", async () => {
    const root = mkdtempSync(join(tmpdir(), "composer-mcp-"));
    try {
      const { client } = await bootClient(root);
      const result = await client.callTool({
        name: "composer_handoff_create",
        arguments: {
          objective: "implement codex-backed coding",
          contextSummary: "Entropy plans; Codex applies complex edits.",
          constraints: ["do not commit"],
          relevantFiles: ["src/server.ts"],
          acceptanceCriteria: ["worker receives the same handoffPath"],
        },
      });
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      const parsed = JSON.parse(block?.text ?? "{}") as {
        handoffPath: string;
        runId: string;
        objective: string;
      };
      expect(parsed.objective).toBe("implement codex-backed coding");
      expect(parsed.runId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(resolve(parsed.handoffPath).startsWith(resolve(root, ".composer/handoffs"))).toBe(true);
      expect(existsSync(parsed.handoffPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("worker tools can receive shared handoff context by path", async () => {
    const root = mkdtempSync(join(tmpdir(), "composer-mcp-"));
    try {
      const { client } = await bootClient(root);
      const handoffResult = await client.callTool({
        name: "composer_handoff_create",
        arguments: {
          objective: "route complex coding to Codex",
          decisions: ["Use Codex through composer_code_cli first."],
        },
      });
      const handoffBlock = (handoffResult.content as Array<{ type: string; text: string }>)[0];
      const { handoffPath } = JSON.parse(handoffBlock?.text ?? "{}") as {
        handoffPath: string;
      };

      const codeResult = await client.callTool({
        name: "composer_code",
        arguments: {
          prompt: "implement it",
          handoffPath,
        },
      });
      const codeBlock = (codeResult.content as Array<{ type: string; text: string }>)[0];
      expect(codeBlock?.text).toContain("Shared handoff:");
      expect(codeBlock?.text).toContain("route complex coding to Codex");
      expect(codeBlock?.text).toContain("Use Codex through composer_code_cli first.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
