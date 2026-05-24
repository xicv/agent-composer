import { describe, it, expect } from "vitest";
import {
  buildReflectionPrompt,
  reflectViaProvider,
  type ReflectionInput,
} from "../../src/evolve/reflection.js";
import type { IProvider } from "../../src/providers/IProvider.js";

const input: ReflectionInput = {
  parent: "## Skill\n\nDO NOT use Edit.",
  taskTranscripts: [
    { task: "fix typo", outcome: "failed: worker dispatched needlessly" },
  ],
  currentEcosystem: "MCP 1.30 released",
};

describe("buildReflectionPrompt", () => {
  it("includes parent + transcripts + ecosystem", () => {
    const p = buildReflectionPrompt(input);
    expect(p).toContain("DO NOT use Edit");
    expect(p).toContain("dispatched needlessly");
    expect(p).toContain("MCP 1.30");
    expect(p).toMatch(/rewrite/i);
  });

  it("omits ecosystem section when empty", () => {
    const p = buildReflectionPrompt({ ...input, currentEcosystem: "" });
    expect(p).not.toMatch(/## Current ecosystem/i);
  });
});

describe("reflectViaProvider", () => {
  it("strips fenced code blocks if the LM wrapped the rewrite", async () => {
    const fenced = "```markdown\n## Skill\n\nNEVER use Edit.\n```";
    const provider: IProvider = {
      id: "anthropic",
      modelLabel: "glm-5.1",
      healthCheck: async () => true,
      execute: async () => ({ text: fenced }),
    };
    const out = await reflectViaProvider(provider, input);
    expect(out).toBe("## Skill\n\nNEVER use Edit.");
  });

  it("returns trimmed text unchanged when no fence", async () => {
    const provider: IProvider = {
      id: "anthropic",
      modelLabel: "glm-5.1",
      healthCheck: async () => true,
      execute: async () => ({ text: "  rewritten body  " }),
    };
    expect(await reflectViaProvider(provider, input)).toBe("rewritten body");
  });

  it("propagates provider errors (reflection failure is fatal to a candidate)", async () => {
    const provider: IProvider = {
      id: "anthropic",
      modelLabel: "glm-5.1",
      healthCheck: async () => true,
      execute: async () => {
        throw new Error("glm 429");
      },
    };
    await expect(reflectViaProvider(provider, input)).rejects.toThrow(/glm 429/);
  });
});
