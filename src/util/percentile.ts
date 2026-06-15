export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)));
  return sorted[index] ?? 0;
}

export function summarizeLatency(samples: readonly number[]): { count: number; p50: number; p95: number; p99: number; max: number } {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: percentile(samples, 1),
  };
}
