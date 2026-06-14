import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComposerServer } from "../../src/server.js";
import type { ProviderRegistry } from "../../src/registry.js";
import { parseConfig } from "../../src/config/loader.js";
import type { ComposerConfig } from "../../src/config/schema.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { IProvider } from "../../src/providers/IProvider.js";

const config: ComposerConfig = parseConfig({
  roles: {
    researcher: { provider: "mock", model: "researcher-mock" },
    coder: { provider: "mock", model: "coder-mock" },
    reviewer: { provider: "mock", model: "reviewer-mock" },
  },
});

async function bootClient(root: string, coder: IProvider) {
  const fallback = new MockProvider();
  const registry = {
    getProviderForRole(role: string): IProvider {
      return role === "coder" ? coder : fallback;
    },
  } as unknown as ProviderRegistry;
  const server = createComposerServer(registry, { root, config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "composer-code-chain-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client };
}

describe("composer_code_chain", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "composer-code-chain-"));
    roots.push(root);
    return root;
  }

  it("applies GLM-authored complete FILE blocks under projectDir", async () => {
    const root = tempRoot();
    const target = tempRoot();
    const authored = [
      "FILE: src/generated.ts",
      "```ts",
      "export const answer = 42;",
      "```",
      "FILE: docs/note.md",
      "```md",
      "# Generated",
      "",
      "This came from the coder provider.",
      "```",
    ].join("\n");
    const coder = new MockProvider({ responses: [authored] });
    const { client } = await bootClient(root, coder);

    const result = await client.callTool({
      name: "composer_code_chain",
      arguments: { prompt: "author files", projectDir: target },
    });

    expect(result.isError).not.toBe(true);
    expect(coder.callCount).toBe(1);
    expect(coder.calls[0]?.cwd).toBe(realpathSync(target));
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Changed 2/2 file(s)");
    expect(text).toContain("src/generated.ts=changed");
    expect(text).toContain("docs/note.md=changed");
    expect(readFileSync(join(target, "src/generated.ts"), "utf8")).toBe(
      "export const answer = 42;\n",
    );
    expect(readFileSync(join(target, "docs/note.md"), "utf8")).toBe(
      "# Generated\n\nThis came from the coder provider.\n",
    );
    expect(existsSync(join(root, "src/generated.ts"))).toBe(false);
  });

  it("reports an error when authored text contains no FILE blocks", async () => {
    const root = tempRoot();
    const coder = new MockProvider({ responses: ["plain prose with no file blocks"] });
    const { client } = await bootClient(root, coder);

    const result = await client.callTool({
      name: "composer_code_chain",
      arguments: { prompt: "author nothing" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("apply produced no changes");
    expect(coder.callCount).toBe(1);
  });
});
