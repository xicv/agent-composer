import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BriefSchema } from "../../src/util/brief.js";
import {
  selectContext,
  writeContextSelectionBrief,
} from "../../src/util/contextSelection.js";

describe("contextSelection", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "composer-context-selection-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("normalizes files and line slices into a valid brief", () => {
    const selection = selectContext({
      task: "  fix readiness gate  ",
      files: ["src/a.ts", " src/a.ts ", ""],
      symbols: ["buildDailyReadiness", "buildDailyReadiness"],
      deps: ["zod", " zod "],
      constraints: ["no broad lint"],
      acceptanceCriteria: ["targeted tests pass"],
      slices: [
        { file: " src/b.ts ", startLine: 10, endLine: 20, note: " current shape " },
        { file: "src/b.ts", startLine: 10, endLine: 20, note: "current shape" },
      ],
    });

    expect(() => BriefSchema.parse(selection.brief)).not.toThrow();
    expect(selection.brief.task).toBe("fix readiness gate");
    expect(selection.brief.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(selection.brief.symbols).toEqual(["buildDailyReadiness"]);
    expect(selection.brief.deps).toEqual(["zod"]);
    expect(selection.brief.constraints).toEqual(["no broad lint"]);
    expect(selection.brief.acceptanceCriteria).toEqual(["targeted tests pass"]);
    expect(selection.brief.slices).toEqual([
      { file: "src/b.ts", startLine: 10, endLine: 20, note: "current shape" },
    ]);
    expect(selection.metrics).toMatchObject({
      fileCount: 2,
      sliceCount: 1,
      symbolCount: 1,
      dependencyCount: 1,
    });
  });

  it("rejects inverted line slices", () => {
    expect(() =>
      selectContext({
        task: "bad slice",
        slices: [{ file: "src/a.ts", startLine: 20, endLine: 10 }],
      }),
    ).toThrow("slice endLine must be >= startLine");
  });

  it("writes the selected brief under the project brief directory", () => {
    const selection = selectContext({
      task: "write selection",
      files: ["src/util/contextSelection.ts"],
    });

    const briefPath = writeContextSelectionBrief(selection, tmp);
    const parsed = BriefSchema.parse(JSON.parse(readFileSync(briefPath, "utf8")));

    expect(briefPath).toContain(join(tmp, ".composer", "briefs"));
    expect(parsed.runId).toBe(selection.brief.runId);
    expect(parsed.files).toEqual(["src/util/contextSelection.ts"]);
  });
});
