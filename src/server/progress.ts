import type { ActiveRunTracker } from "./activeRuns.js";

export type ProgressUpdate = { phase?: string; detail?: string };

export type ToolProgressExtra = {
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
};

export async function withProgress<T>(
  extra: ToolProgressExtra,
  label: string,
  work: (onProgress: (update: ProgressUpdate) => void) => Promise<T>,
  opts: { tracker?: ActiveRunTracker; providerRole?: string; providerLabel?: string } = {},
): Promise<T> {
  const reporter = createProgressReporter(extra, label, opts);
  const runId = opts.tracker
    ? opts.tracker.start({
        tool: label,
        providerRole: opts.providerRole,
        providerLabel: opts.providerLabel,
      })
    : undefined;
  await reporter.report("started");
  try {
    const result = await work(reporter.onProgress);
    await reporter.report("completed");
    return result;
  } catch (error) {
    await reporter.report("failed");
    throw error;
  } finally {
    reporter.stop();
    if (opts.tracker && runId !== undefined) opts.tracker.finish(runId);
  }
}

function createProgressReporter(
  extra: ToolProgressExtra,
  label: string,
  opts: { providerRole?: string; providerLabel?: string },
) {
  const progressToken = extra._meta?.progressToken;
  const startedAt = Date.now();
  let progress = 0;
  let active = true;
  let phase = "working";
  let detail: string | undefined;
  let lastProgressUpdateAt = 0;

  const report = async (state?: string) => {
    if (!active || progressToken === undefined || !extra.sendNotification) {
      return;
    }
    const messagePhase = phaseForState(state) ?? phase;
    progress += 1;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: formatProgressMessage({
            label,
            provider: opts.providerLabel ?? opts.providerRole,
            elapsed: formatElapsed(Date.now() - startedAt),
            phase: messagePhase,
            detail,
          }),
        },
      });
    } catch {
      // Progress is advisory; never fail the tool because a client ignores it.
    }
  };

  const timer =
    progressToken !== undefined && extra.sendNotification
      ? setInterval(() => {
          void report();
        }, 30_000)
      : undefined;

  return {
    report,
    onProgress: (update: ProgressUpdate) => {
      if (typeof update.phase === "string" && update.phase.trim()) {
        phase = update.phase.trim();
      }
      if (typeof update.detail === "string") {
        const trimmed = update.detail.trim();
        detail = trimmed ? trimmed : undefined;
      }
      const now = Date.now();
      if (now - lastProgressUpdateAt >= 1000) {
        lastProgressUpdateAt = now;
        void report();
      }
    },
    stop: () => {
      active = false;
      if (timer) clearInterval(timer);
    },
  };
}

function phaseForState(state: string | undefined): string | undefined {
  if (state === "started" || state === "completed" || state === "failed") {
    return state;
  }
  return undefined;
}

function formatProgressMessage(input: {
  label: string;
  provider?: string;
  elapsed: string;
  phase: string;
  detail?: string;
}): string {
  return [
    input.label,
    input.provider,
    input.elapsed,
    input.phase,
    input.detail,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
