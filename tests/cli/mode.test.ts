import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyMode } from "../../src/cli/mode.js";

describe("applyMode — error cases", () => {
  it("throws a clear error when composer.config.json does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-mode-err-"));
    try {
      expect(() => applyMode(tmpDir, "strict")).toThrow(/config not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
