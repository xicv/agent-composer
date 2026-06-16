export interface DeadlineSignal {
  signal: AbortSignal;
  startedAt: number;
  deadlineAt: number;
  timeoutMs: number;
  remainingMs: () => number;
  throwIfAborted: () => void;
  cleanup: () => void;
}

export function createDeadlineSignal(
  label: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): DeadlineSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label}: total_wall_clock_ms must be a positive finite number`);
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const timeoutController = new AbortController();
  const combinedController = new AbortController();
  const timeoutError = new Error(`${label}: timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";

  const timer = setTimeout(() => {
    timeoutController.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  const abortFrom = (source: AbortSignal) => {
    if (combinedController.signal.aborted) return;
    combinedController.abort(abortReason(source, label));
  };
  const onCallerAbort = () => {
    if (callerSignal) abortFrom(callerSignal);
  };
  const onTimeoutAbort = () => abortFrom(timeoutController.signal);

  if (callerSignal?.aborted) {
    abortFrom(callerSignal);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });

  const expireIfNeeded = () => {
    if (!combinedController.signal.aborted && Date.now() >= deadlineAt) {
      timeoutController.abort(timeoutError);
    }
  };

  return {
    signal: combinedController.signal,
    startedAt,
    deadlineAt,
    timeoutMs,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    throwIfAborted: () => {
      expireIfNeeded();
      throwIfAborted(combinedController.signal, label);
    },
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
    },
  };
}

export async function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  throwIfAborted(signal, label);
  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      finish(() => reject(abortReason(signal, label)));
    };

    timer = setTimeout(() => {
      finish(resolve);
    }, ms);
    timer.unref?.();

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (!signal?.aborted) return;
  throw abortReason(signal, label);
}

export function abortReason(signal: AbortSignal | undefined, label: string): Error {
  const reason = signal?.reason as unknown;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : `${label}: aborted`,
  );
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || /\b(abort|aborted|cancelled|canceled)\b/i.test(message);
}
