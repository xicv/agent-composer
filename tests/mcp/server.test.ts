import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createComposerServer } from "../../src/server.js";
import { ProviderRegistry } from "../../src/registry.js";
import { parseConfig } from "../../src/config/loader.js";
import type { ComposerConfig } from "../../src/config/schema.js";

const allMockConfig: ComposerConfig = parseConfig({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
  },
});

async function bootClient() {
  const registry = new ProviderRegistry(allMockConfig);
  const server = createComposerServer(registry);
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
  it("registers exactly 4 tools with C0.3 locked names", async () => {
    const { client } = await bootClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "composer_code",
      "composer_code_cli",
      "composer_research",
      "composer_review",
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

  it("validates input — composer_code without prompt returns isError", async () => {
    const { client } = await bootClient();
    const result = await client.callTool({
      name: "composer_code",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});
