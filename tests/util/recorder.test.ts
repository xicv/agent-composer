import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  TapeProvider,
  RecordingProvider,
  loadTape,
  TapeMismatchError,
  TapeExhaustedError,
  wrapWithRecorder,
} from "./recorder.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

describe("TapeProvider", () => {
  it("serves recorded outputs in order", async () => {
    const p = new TapeProvider([
      { input: { prompt: "x" }, output: { text: "X" } },
      { input: { prompt: "y" }, output: { text: "Y" } },
    ]);
    expect((await p.execute({ prompt: "x" })).text).toBe("X");
    expect((await p.execute({ prompt: "y" })).text).toBe("Y");
  });

  it("throws TapeMismatchError on prompt mismatch", async () => {
    const p = new TapeProvider([
      { input: { prompt: "x" }, output: { text: "X" } },
    ]);
    await expect(p.execute({ prompt: "z" })).rejects.toBeInstanceOf(
      TapeMismatchError,
    );
  });

  it("throws TapeExhaustedError when cursor past end", async () => {
    const p = new TapeProvider([
      { input: { prompt: "x" }, output: { text: "X" } },
    ]);
    await p.execute({ prompt: "x" });
    await expect(p.execute({ prompt: "y" })).rejects.toBeInstanceOf(
      TapeExhaustedError,
    );
  });
});

describe("RecordingProvider + loadTape round-trip", () => {
  it("captures execute() calls and writes JSON tape", async () => {
    const tapePath = path.join(os.tmpdir(), `tape-${Date.now()}.json`);
    const rec = new RecordingProvider(new MockProvider(), tapePath);
    await rec.execute({ prompt: "one" });
    await rec.execute({ prompt: "two", context: "ctx" });
    rec.flush();
    try {
      const loaded = loadTape(tapePath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]?.input.prompt).toBe("one");
      expect(loaded[1]?.input.context).toBe("ctx");
      expect(loaded[1]?.output.text).toContain("two");
    } finally {
      fs.unlinkSync(tapePath);
    }
  });

  it("loadTape throws on missing file with re-record hint", () => {
    expect(() =>
      loadTape("/tmp/nonexistent-tape-xyz.json"),
    ).toThrow(/RECORD=1/);
  });
});

describe("wrapWithRecorder", () => {
  it("returns RecordingProvider when record=true", () => {
    const tapePath = path.join(os.tmpdir(), `tape-${Date.now()}.json`);
    const w = wrapWithRecorder(new MockProvider(), tapePath, true);
    expect(w).toBeInstanceOf(RecordingProvider);
  });

  it("returns TapeProvider when record=false (tape exists)", async () => {
    const tapePath = path.join(os.tmpdir(), `tape-${Date.now()}.json`);
    const rec = new RecordingProvider(new MockProvider(), tapePath);
    await rec.execute({ prompt: "seed" });
    rec.flush();
    try {
      const w = wrapWithRecorder(new MockProvider(), tapePath, false);
      expect(w).toBeInstanceOf(TapeProvider);
    } finally {
      fs.unlinkSync(tapePath);
    }
  });
});
