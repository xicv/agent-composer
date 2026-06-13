export interface ActiveRun {
  id: number;
  tool: string;
  providerRole?: string;
  startedAt: string; // ISO
}

export interface ActiveRunTracker {
  start(input: { tool: string; providerRole?: string }): number;
  finish(id: number): void;
  list(): ActiveRun[];
}

export function createActiveRunTracker(): ActiveRunTracker {
  let nextId = 1;
  const runs = new Map<number, ActiveRun>();
  return {
    start({ tool, providerRole }) {
      const id = nextId++;
      runs.set(id, { id, tool, providerRole, startedAt: new Date().toISOString() });
      return id;
    },
    finish(id) {
      runs.delete(id);
    },
    list() {
      return [...runs.values()];
    },
  };
}
