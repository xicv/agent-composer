import { describe, it, expect } from "vitest";
import { resolveInitInvocation } from "../../src/cli/initArgs.js";

describe("resolveInitInvocation", () => {
  it("no flags → project init, no oracle", () => {
    expect(resolveInitInvocation([])).toEqual({ kind: "project", installOracle: false });
  });

  it("--oracle → project init with oracle", () => {
    expect(resolveInitInvocation(["--oracle"])).toEqual({ kind: "project", installOracle: true });
  });

  it("--global → global init", () => {
    expect(resolveInitInvocation(["--global"])).toEqual({ kind: "global" });
  });

  it("--global --oracle → error mentioning project-scoped and cannot be combined with --global", () => {
    const result = resolveInitInvocation(["--global", "--oracle"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("project-scoped");
      expect(result.message).toContain("cannot be combined with --global");
    }
  });

  it("--oracle --global (order swapped) → error", () => {
    const result = resolveInitInvocation(["--oracle", "--global"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("project-scoped");
      expect(result.message).toContain("cannot be combined with --global");
    }
  });

  it("unrelated flag --foo → project init, no oracle", () => {
    expect(resolveInitInvocation(["--foo"])).toEqual({ kind: "project", installOracle: false });
  });
});
