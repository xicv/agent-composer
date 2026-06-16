import { afterEach, describe, expect, it, vi } from "vitest";

import { pollJobResult } from "../../src/util/jobPolling.js";

describe("pollJobResult", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a waiting poll immediately without another read", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    let reads = 0;

    const pending = pollJobResult(
      () => {
        reads += 1;
        return { status: "running" };
      },
      {
        waitMs: 10_000,
        signal: ac.signal,
        label: "test_poll",
        intervalMs: 150,
      },
    );

    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    ac.abort(new Error("stop polling"));

    await expect(pending).rejects.toThrow("stop polling");
    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
