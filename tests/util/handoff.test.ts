import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HANDOFF_DIR,
  HandoffPacketSchema,
  formatHandoffForPrompt,
  newHandoffPacket,
  readHandoffPacket,
  writeHandoffPacket,
} from "../../src/util/handoff.js";

describe("handoff", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-handoff-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("newHandoffPacket returns a valid provider-neutral packet", () => {
    const packet = newHandoffPacket({
      objective: "share context with Codex",
      contextSummary: "Entropy owns planning; Codex owns complex edits.",
      constraints: ["do not commit"],
      relevantFiles: ["src/server.ts"],
      acceptanceCriteria: ["worker can consume handoffPath"],
    });

    expect(() => HandoffPacketSchema.parse(packet)).not.toThrow();
    expect(packet.version).toBe(1);
    expect(packet.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(packet.objective).toBe("share context with Codex");
    expect(packet.constraints).toEqual(["do not commit"]);
  });

  it("writeHandoffPacket and readHandoffPacket round-trip under .composer/handoffs", () => {
    const packet = newHandoffPacket({
      objective: "round trip",
      decisions: ["Codex CLI is the pilot path."],
    });
    const path = writeHandoffPacket(packet, resolve(tmp, HANDOFF_DIR));
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("Codex CLI is the pilot path.");

    const relativePath = path.slice(resolve(tmp).length + 1);
    const parsed = readHandoffPacket(relativePath, tmp);
    expect(parsed.runId).toBe(packet.runId);
    expect(parsed.decisions).toEqual(["Codex CLI is the pilot path."]);
  });

  it("readHandoffPacket rejects paths outside .composer/handoffs", () => {
    expect(() => readHandoffPacket("composer.config.json", tmp)).toThrow(
      /handoffPath must resolve under/,
    );
  });

  it("formatHandoffForPrompt creates compact shared context", () => {
    const packet = newHandoffPacket({
      objective: "complex coding",
      constraints: ["lint only touched files"],
      relevantFiles: ["src/server.ts"],
      artifacts: [
        {
          kind: "research",
          source: "OpenAI docs",
          summary: "Use codex exec for non-interactive automation.",
        },
      ],
    });

    const formatted = formatHandoffForPrompt(packet);
    expect(formatted).toContain("Shared handoff:");
    expect(formatted).toContain("complex coding");
    expect(formatted).toContain("lint only touched files");
    expect(formatted).toContain("OpenAI docs");
  });
});
