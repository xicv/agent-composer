import { describe, it, expect } from "vitest";
import { createActiveRunTracker } from "../../src/server/activeRuns.js";
import type { ToolProgressExtra } from "../../src/server/progress.js";
import { withProgress } from "../../src/server/progress.js";

describe("createActiveRunTracker", () => {
  it("start returns increasing ids", () => {
    const tracker = createActiveRunTracker();
    const id1 = tracker.start({ tool: "composer_research" });
    const id2 = tracker.start({ tool: "composer_code_cli" });
    expect(id2).toBeGreaterThan(id1);
  });

  it("list shows started runs with tool and startedAt", () => {
    const tracker = createActiveRunTracker();
    tracker.start({ tool: "composer_research" });
    const runs = tracker.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.tool).toBe("composer_research");
    expect(typeof runs[0]!.startedAt).toBe("string");
    expect(() => new Date(runs[0]!.startedAt)).not.toThrow();
  });

  it("finish removes run by id", () => {
    const tracker = createActiveRunTracker();
    const id = tracker.start({ tool: "composer_code" });
    expect(tracker.list()).toHaveLength(1);
    tracker.finish(id);
    expect(tracker.list()).toHaveLength(0);
  });

  it("finishing unknown id is a no-op", () => {
    const tracker = createActiveRunTracker();
    tracker.start({ tool: "composer_review" });
    expect(() => tracker.finish(999)).not.toThrow();
    expect(tracker.list()).toHaveLength(1);
  });

  it("multiple concurrent runs listed", () => {
    const tracker = createActiveRunTracker();
    const id1 = tracker.start({ tool: "composer_research" });
    const id2 = tracker.start({ tool: "composer_code_cli" });
    const id3 = tracker.start({ tool: "composer_review", providerRole: "reviewer" });
    expect(tracker.list()).toHaveLength(3);
    tracker.finish(id2);
    const remaining = tracker.list();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.id)).toContain(id1);
    expect(remaining.map((r) => r.id)).toContain(id3);
  });

  it("providerRole is stored when provided", () => {
    const tracker = createActiveRunTracker();
    tracker.start({ tool: "composer_review", providerRole: "reviewer" });
    const runs = tracker.list();
    expect(runs[0]!.providerRole).toBe("reviewer");
  });

  it("providerRole is undefined when not provided", () => {
    const tracker = createActiveRunTracker();
    tracker.start({ tool: "composer_research" });
    const runs = tracker.list();
    expect(runs[0]!.providerRole).toBeUndefined();
  });
});

describe("withProgress + tracker integration", () => {
  it("tracker.list() is non-empty while work promise is pending, empty after resolve", async () => {
    const tracker = createActiveRunTracker();
    const fakeExtra: ToolProgressExtra = {};

    let resolveWork!: () => void;
    const pendingPromise = new Promise<void>((res) => {
      resolveWork = res;
    });

    const workFn = () => pendingPromise;

    // Start withProgress but don't await it yet
    const progressPromise = withProgress(fakeExtra, "composer_code_cli", workFn, { tracker });

    // Give the microtask queue a tick to let withProgress start and register the run
    await Promise.resolve();

    // Now the run should be registered
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]!.tool).toBe("composer_code_cli");

    // Resolve the work
    resolveWork();
    await progressPromise;

    // After completion, run should be removed
    expect(tracker.list()).toHaveLength(0);
  });

  it("tracker.list() is empty after work throws", async () => {
    const tracker = createActiveRunTracker();
    const fakeExtra: ToolProgressExtra = {};

    const workFn = () => Promise.reject(new Error("test error"));

    await expect(
      withProgress(fakeExtra, "composer_code_cli", workFn, { tracker }),
    ).rejects.toThrow("test error");

    expect(tracker.list()).toHaveLength(0);
  });
});
