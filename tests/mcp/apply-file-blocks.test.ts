import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFileBlocks } from "../../src/server.js";

describe("applyFileBlocks", () => {
  it("writes FILE: blocks under root and guards path traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afb-"));
    try {
      const text = [
        "FILE: src/a.ts",
        "```ts",
        "export const a = 1;",
        "```",
        "FILE: ../evil.ts",
        "```ts",
        "bad",
        "```",
      ].join("\n");
      const { written, skipped } = applyFileBlocks(text, root);
      expect(written).toEqual(["src/a.ts"]);
      expect(skipped.length).toBe(1);
      expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain(
        "export const a = 1;",
      );
      expect(fs.existsSync(path.resolve(root, "../evil.ts"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no written files when there are no FILE: blocks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afb-"));
    try {
      const { written } = applyFileBlocks("just prose, no blocks", root);
      expect(written).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
