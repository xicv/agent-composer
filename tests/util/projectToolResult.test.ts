import { describe, expect, it } from "vitest";

import { projectToolResult } from "../../src/util/projectToolResult.js";

describe("projectToolResult", () => {
  it("passes through input at or under the threshold", () => {
    const input = "short worker output\nwith two lines";

    const result = projectToolResult(input, { maxChars: 200 });

    expect(result).toEqual({
      text: input,
      projected: false,
      originalChars: input.length,
      keptChars: input.length,
      kind: "generic",
    });
  });

  it("passes through empty input as generic output", () => {
    expect(projectToolResult("")).toEqual({
      text: "",
      projected: false,
      originalChars: 0,
      keptChars: 0,
      kind: "generic",
    });
  });

  it("bounds generic over-threshold output with a deterministic head, tail, and elision marker", () => {
    const input = Array.from(
      { length: 24 },
      (_, index) => `line-${String(index).padStart(2, "0")} ${"x".repeat(18)}`,
    ).join("\n");

    const result = projectToolResult(input, { maxChars: 200 });

    expect(result.projected).toBe(true);
    expect(result.kind).toBe("generic");
    expect(result.originalChars).toBe(input.length);
    expect(result.keptChars).toBe(result.text.length);
    expect(result.text).toContain("… [elided ");
    expect(result.text).toMatch(/elided \d+ chars \/ \d+ lines/);
    expect(result.text.startsWith(input.slice(0, 120))).toBe(true);
    expect(result.text.endsWith(input.slice(-50))).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(260);
  });

  it("detects and projects diff output", () => {
    const input = [
      "diff --git a/src/server.ts b/src/server.ts",
      "index 1111111..2222222 100644",
      "--- a/src/server.ts",
      "+++ b/src/server.ts",
      "@@ -1,4 +1,5 @@",
      "-export const port = 3000;",
      "+export const port = 4000;",
      "+export const host = \"127.0.0.1\";",
      " export function start() {",
      "   return port;",
      " }",
      ...Array.from({ length: 24 }, (_, index) => `+added line ${index}`),
    ].join("\n");

    const result = projectToolResult(input, { maxChars: 180 });

    expect(result.kind).toBe("diff");
    expect(result.projected).toBe(true);
    expect(result.text).toContain("diff --git");
    expect(result.text).toContain("… [elided ");
  });

  it("summarizes projected JSON without slicing mid-token", () => {
    const input = JSON.stringify(
      Array.from({ length: 20 }, (_, index) => ({
        id: index,
        name: `item-${index}`,
        tags: ["alpha", "beta"],
        meta: { active: index % 2 === 0, score: index * 10 },
      })),
    );

    const result = projectToolResult(input, { maxChars: 200 });

    expect(result.kind).toBe("json");
    expect(result.projected).toBe(true);
    expect(result.text).toContain("[projected JSON:");
    expect(result.text).toContain("array(length=20");
    expect(result.text).toContain("sample");
    expect(result.text.length).toBeLessThanOrEqual(220);
  });

  it("collapses more than three identical adjacent lines before projection", () => {
    const repeated = "same failure line";
    const input = [
      "header",
      ...Array.from({ length: 12 }, () => repeated),
      ...Array.from({ length: 20 }, (_, index) => `tail-${index}`),
    ].join("\n");

    const result = projectToolResult(input, {
      maxChars: 120,
      headChars: 80,
      tailChars: 20,
    });

    expect(result.projected).toBe(true);
    expect(result.text).toContain(`${repeated} … (×12)`);
    expect(result.text.match(new RegExp(repeated, "g"))).toHaveLength(1);
  });

  it("is idempotent for already projected bounded output", () => {
    const input = Array.from(
      { length: 30 },
      (_, index) => `line-${index} ${"x".repeat(20)}`,
    ).join("\n");

    const first = projectToolResult(input, { maxChars: 180 });
    const second = projectToolResult(first.text, { maxChars: 260 });

    expect(first.projected).toBe(true);
    expect(second.projected).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.originalChars).toBe(first.text.length);
  });
});
