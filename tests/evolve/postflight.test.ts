import { describe, it, expect } from "vitest";
import {
  runPostflight,
  buildPostflightPrompt,
  parseVerdict,
} from "../../src/evolve/postflight.js";
import type { IProvider } from "../../src/providers/IProvider.js";

function mockProvider(reply: string): IProvider {
  return {
    id: "cli",
    modelLabel: "agy-mock",
    healthCheck: async () => true,
    execute: async () => ({ text: reply }),
  };
}

describe("buildPostflightPrompt", () => {
  it("includes both ecosystem snapshot and candidate text", () => {
    const p = buildPostflightPrompt({
      ecosystem: "MCP 1.30 released",
      candidate: "Use mcp.create_session() helper",
    });
    expect(p).toContain("MCP 1.30 released");
    expect(p).toContain("mcp.create_session");
    expect(p).toMatch(/deprecated/i);
  });
});

describe("parseVerdict", () => {
  it("ACCEPT verdict", () => {
    const v = parseVerdict("VERDICT: ACCEPT\nLooks fine.");
    expect(v.accept).toBe(true);
    expect(v.reason).toMatch(/fine/i);
  });

  it("REJECT verdict captures reason", () => {
    const v = parseVerdict("VERDICT: REJECT\nReferences foo.bar which was removed in 2.0.");
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(/foo\.bar/);
  });

  it("ambiguous reply defaults to REJECT (fail-safe)", () => {
    const v = parseVerdict("hmm, unsure");
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(/no verdict/i);
  });
});

describe("runPostflight", () => {
  it("accepts when LM emits VERDICT: ACCEPT", async () => {
    const provider = mockProvider("VERDICT: ACCEPT\nNo deprecated APIs found.");
    const out = await runPostflight(provider, {
      ecosystem: "fresh",
      candidate: "skill body",
    });
    expect(out.accept).toBe(true);
  });

  it("rejects when LM emits VERDICT: REJECT", async () => {
    const provider = mockProvider("VERDICT: REJECT\nUses old API.");
    const out = await runPostflight(provider, {
      ecosystem: "fresh",
      candidate: "skill body",
    });
    expect(out.accept).toBe(false);
  });

  it("rejects on provider failure (fail-safe)", async () => {
    const provider: IProvider = {
      id: "cli",
      modelLabel: "agy-mock",
      healthCheck: async () => true,
      execute: async () => {
        throw new Error("agy unavailable");
      },
    };
    const out = await runPostflight(provider, {
      ecosystem: "x",
      candidate: "y",
    });
    expect(out.accept).toBe(false);
    expect(out.reason).toMatch(/agy unavailable/);
  });
});
