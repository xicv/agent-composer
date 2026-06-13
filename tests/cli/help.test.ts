import { describe, it, expect } from "vitest";
import { formatHelp } from "../../src/cli/help.js";

describe("formatHelp", () => {
  it("returns a string", () => {
    expect(typeof formatHelp()).toBe("string");
  });

  it("includes Usage: section header", () => {
    expect(formatHelp()).toContain("Usage:");
  });

  it("includes agent-composer init", () => {
    expect(formatHelp()).toContain("agent-composer init");
  });

  it("includes agent-composer doctor", () => {
    expect(formatHelp()).toContain("agent-composer doctor");
  });

  it("includes doctor --json flag", () => {
    expect(formatHelp()).toContain("doctor --json");
  });

  it("includes init --oracle flag", () => {
    expect(formatHelp()).toContain("init --oracle");
  });

  it("includes init --global flag", () => {
    expect(formatHelp()).toContain("init --global");
  });

  it("includes agent-composer help", () => {
    expect(formatHelp()).toContain("agent-composer help");
  });

  it("includes note that --oracle cannot be combined with --global", () => {
    expect(formatHelp()).toContain("cannot be combined with --global");
  });

  it("includes agent-composer cleanup", () => {
    expect(formatHelp()).toContain("agent-composer cleanup");
  });
});
