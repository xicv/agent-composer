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
      expect(() => applyFileBlocks(text, root)).toThrow(/outside projectDir/);
      expect(fs.existsSync(path.join(root, "src/a.ts"))).toBe(false);
      expect(fs.existsSync(path.resolve(root, "../evil.ts"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes FILE: blocks under root and reports changed status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afb-"));
    try {
      const text = [
        "FILE: src/a.ts",
        "```ts",
        "export const a = 1;",
        "```",
      ].join("\n");
      const { files } = applyFileBlocks(text, root);
      expect(files).toEqual([{ path: "src/a.ts", status: "changed" }]);
      expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe(
        "export const a = 1;\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unchanged files without rewriting identical content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afb-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/a.ts"), "same\n", "utf8");
      const text = ["FILE: src/a.ts", "```ts", "same", "```"].join("\n");
      const { files } = applyFileBlocks(text, root);
      expect(files).toEqual([{ path: "src/a.ts", status: "unchanged" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no files when there are no FILE: blocks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afb-"));
    try {
      const { files } = applyFileBlocks("just prose, no blocks", root);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
