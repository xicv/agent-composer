import { describe, it, expect } from "vitest";
import { runPreflight, buildPreflightPrompt } from "../../src/evolve/preflight.js";
import type { IProvider } from "../../src/providers/IProvider.js";

function mockProvider(reply: string): IProvider {
  return {
    id: "cli",
    modelLabel: "agy-mock",
    healthCheck: async () => true,
    execute: async () => ({ text: reply }),
  };
}

describe("buildPreflightPrompt", () => {
  it("embeds skillDomain + lastEvolveDate", () => {
    const p = buildPreflightPrompt({
      skillDomain: "MCP orchestration",
      lastEvolveDate: "2026-05-01",
    });
    expect(p).toContain("MCP orchestration");
    expect(p).toContain("2026-05-01");
    expect(p).toMatch(/what changed/i);
  });

  it("uses 'never' when lastEvolveDate omitted", () => {
    const p = buildPreflightPrompt({ skillDomain: "Vue 3" });
    expect(p).toMatch(/never/i);
  });
});

describe("runPreflight", () => {
  it("returns ecosystem snapshot from provider", async () => {
    const provider = mockProvider("MCP SDK 1.30 released; new initialize/handshake.");
    const snap = await runPreflight(provider, {
      skillDomain: "MCP",
      lastEvolveDate: "2026-04-01",
    });
    expect(snap.text).toContain("MCP SDK 1.30");
    expect(snap.fetchedAt).toBeTruthy();
    expect(snap.prompt).toMatch(/MCP/);
  });

  it("returns empty snapshot on provider failure (preflight is best-effort)", async () => {
    const provider: IProvider = {
      id: "cli",
      modelLabel: "agy-mock",
      healthCheck: async () => true,
      execute: async () => {
        throw new Error("network down");
      },
    };
    const snap = await runPreflight(provider, { skillDomain: "X" });
    expect(snap.text).toBe("");
    expect(snap.error).toMatch(/network down/);
  });
});
