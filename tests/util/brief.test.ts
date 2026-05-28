import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BriefSchema, newBrief, writeBrief } from "../../src/util/brief.js";

describe("brief", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-brief-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("newBrief returns valid schema with uuid, iso, empty arrays", () => {
    const b = newBrief("explore auth module");
    expect(() => BriefSchema.parse(b)).not.toThrow();
    expect(b.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(() => new Date(b.createdAt).toISOString()).not.toThrow();
    expect(b.task).toBe("explore auth module");
    expect(b.files).toEqual([]);
    expect(b.slices).toEqual([]);
  });

  it("BriefSchema rejects missing required fields", () => {
    expect(() => BriefSchema.parse({})).toThrow();
    expect(() =>
      BriefSchema.parse({ runId: "not-a-uuid", createdAt: "now", task: "x", files: [], slices: [] }),
    ).toThrow();
    expect(() =>
      BriefSchema.parse({
        runId: "00000000-0000-4000-8000-000000000000",
        createdAt: new Date().toISOString(),
        files: [],
        slices: [],
      }),
    ).toThrow();
  });

  it("writeBrief round-trips through tmpdir", () => {
    const b = newBrief("round-trip test");
    b.files.push("src/util/brief.ts");
    b.slices.push({ file: "src/util/brief.ts", startLine: 1, endLine: 10 });
    const path = writeBrief(b, tmp);
    const raw = readFileSync(path, "utf8");
    const parsed = BriefSchema.parse(JSON.parse(raw));
    expect(parsed.runId).toBe(b.runId);
    expect(parsed.task).toBe("round-trip test");
    expect(parsed.files).toEqual(["src/util/brief.ts"]);
    expect(parsed.slices[0]?.file).toBe("src/util/brief.ts");
  });
});
