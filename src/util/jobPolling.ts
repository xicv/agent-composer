import {
  abortableDelay,
  throwIfAborted,
} from "./asyncControl.js";

export type PollableJob = {
  status?: string;
};

export async function pollJobResult<T extends PollableJob>(
  read: () => T | null,
  input: {
    waitMs?: number;
    signal?: AbortSignal;
    label: string;
    intervalMs?: number;
  },
): Promise<T | null> {
  const intervalMs = input.intervalMs ?? 150;
  const deadline = Date.now() + (input.waitMs ?? 0);
  let job = read();
  while (job && isActiveJob(job) && Date.now() < deadline) {
    throwIfAborted(input.signal, input.label);
    await abortableDelay(
      Math.min(intervalMs, Math.max(0, deadline - Date.now())),
      input.signal,
      input.label,
    );
    throwIfAborted(input.signal, input.label);
    job = read();
  }
  return job;
}

function isActiveJob(job: PollableJob): boolean {
  return job.status === "queued" || job.status === "running";
}
