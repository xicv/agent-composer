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
  work: () => Promise<T>,
): Promise<T> {
  const reporter = createProgressReporter(extra, label);
  await reporter.report("started");
  try {
    const result = await work();
    await reporter.report("completed");
    return result;
  } catch (error) {
    await reporter.report("failed");
    throw error;
  } finally {
    reporter.stop();
  }
}

function createProgressReporter(extra: ToolProgressExtra, label: string) {
  const progressToken = extra._meta?.progressToken;
  let progress = 0;
  let active = true;

  const report = async (state: string) => {
    if (!active || progressToken === undefined || !extra.sendNotification) {
      return;
    }
    progress += 1;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: `${label} ${state}`,
        },
      });
    } catch {
      // Progress is advisory; never fail the tool because a client ignores it.
    }
  };

  const timer =
    progressToken !== undefined && extra.sendNotification
      ? setInterval(() => {
          void report("still running");
        }, 30_000)
      : undefined;

  return {
    report,
    stop: () => {
      active = false;
      if (timer) clearInterval(timer);
    },
  };
}
