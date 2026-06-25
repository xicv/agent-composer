import { z } from "zod";

export const RouteNameSchema = z.enum([
  "cc-only",
  "composer-codex-cli",
]);
export type RouteName = z.infer<typeof RouteNameSchema>;

export const RouteRunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    route: RouteNameSchema,
    observedRoute: z.string().min(1).optional(),
    run: z.number().int().min(1),
    success: z.boolean(),
    ccTokens: z.number().int().nonnegative(),
    baselineCcTokens: z.number().int().positive().optional(),
    durationMs: z.number().nonnegative(),
    routeHonored: z.boolean(),
    testsPassed: z.boolean().optional(),
    reviewPassed: z.boolean().optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    fixIterations: z.number().int().nonnegative().optional(),
    workerCalls: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  })
  .strict();
export type RouteRunRecord = z.infer<typeof RouteRunRecordSchema>;

export interface RouteSummary {
  route: RouteName;
  runCount: number;
  taskCount: number;
  successRate: number;
  routeHonoredRate: number;
  testsPassRate?: number;
  reviewPassRate?: number;
  meanCcTokens: number;
  medianCcTokens: number;
  meanDurationMs: number;
  meanFilesChanged?: number;
  meanFixIterations?: number;
  meanSavingsVsBaselinePct?: number;
  confidenceScore: number;
}

export interface RouteComparisonSummary {
  baselineRoute: RouteName;
  runCount: number;
  routes: RouteSummary[];
}

export function parseRouteRunJsonl(text: string): RouteRunRecord[] {
  const rows: RouteRunRecord[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`route JSONL line ${index + 1}: invalid JSON: ${detail}`);
    }
    const result = RouteRunRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new Error(`route JSONL line ${index + 1}: schema validation failed: ${issues}`);
    }
    rows.push(result.data);
  }
  return rows;
}

export function summarizeRouteRuns(
  records: ReadonlyArray<RouteRunRecord>,
  baselineRoute: RouteName = "cc-only",
): RouteComparisonSummary {
  const baselineByTask = medianTokensByTask(records, baselineRoute);
  const byRoute = new Map<RouteName, RouteRunRecord[]>();
  for (const record of records) {
    const rows = byRoute.get(record.route) ?? [];
    rows.push(record);
    byRoute.set(record.route, rows);
  }

  const routes = [...byRoute.entries()]
    .map(([route, rows]) => summarizeRoute(route, rows, baselineByTask))
    .sort((a, b) => routeOrder(a.route) - routeOrder(b.route));

  return {
    baselineRoute,
    runCount: records.length,
    routes,
  };
}

export function formatRouteSummary(summary: RouteComparisonSummary): string {
  const header = [
    "route",
    "runs",
    "tasks",
    "success",
    "honored",
    "cc_median",
    "cc_mean",
    "save_vs_base",
    "confidence",
  ];
  const rows = summary.routes.map((route) => [
    route.route,
    String(route.runCount),
    String(route.taskCount),
    pct(route.successRate),
    pct(route.routeHonoredRate),
    String(route.medianCcTokens),
    String(route.meanCcTokens),
    route.meanSavingsVsBaselinePct === undefined
      ? "-"
      : pct(route.meanSavingsVsBaselinePct / 100),
    route.confidenceScore.toFixed(3),
  ]);
  const table = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...table.map((row) => row[col]?.length ?? 0)),
  );
  return table
    .map((row) =>
      row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  "),
    )
    .join("\n");
}

function summarizeRoute(
  route: RouteName,
  rows: ReadonlyArray<RouteRunRecord>,
  baselineByTask: ReadonlyMap<string, number>,
): RouteSummary {
  const ccTokens = rows.map((row) => row.ccTokens);
  const savings = rows
    .map((row) => {
      const baseline = row.baselineCcTokens ?? baselineByTask.get(row.taskId);
      if (!baseline || baseline <= 0) return undefined;
      return (1 - row.ccTokens / baseline) * 100;
    })
    .filter((value): value is number => value !== undefined);
  const tests = optionalBooleans(rows.map((row) => row.testsPassed));
  const reviews = optionalBooleans(rows.map((row) => row.reviewPassed));
  const changed = optionalNumbers(rows.map((row) => row.filesChanged));
  const fixIterations = optionalNumbers(rows.map((row) => row.fixIterations));
  const qualityGateRate = gateRate(rows);
  const meanSavings = savings.length > 0 ? round1(mean(savings)) : undefined;
  const savingsScore =
    meanSavings === undefined ? 0 : clamp(meanSavings / 100, -1, 1);
  const confidenceScore = round3(
    0.45 * ratio(rows.filter((row) => row.success).length, rows.length) +
      0.2 * ratio(rows.filter((row) => row.routeHonored).length, rows.length) +
      0.2 * qualityGateRate +
      0.15 * Math.max(0, savingsScore),
  );

  return {
    route,
    runCount: rows.length,
    taskCount: new Set(rows.map((row) => row.taskId)).size,
    successRate: round3(ratio(rows.filter((row) => row.success).length, rows.length)),
    routeHonoredRate: round3(ratio(rows.filter((row) => row.routeHonored).length, rows.length)),
    testsPassRate: tests === undefined ? undefined : round3(tests),
    reviewPassRate: reviews === undefined ? undefined : round3(reviews),
    meanCcTokens: Math.round(mean(ccTokens)),
    medianCcTokens: Math.round(median(ccTokens)),
    meanDurationMs: Math.round(mean(rows.map((row) => row.durationMs))),
    meanFilesChanged: changed === undefined ? undefined : round1(changed),
    meanFixIterations: fixIterations === undefined ? undefined : round1(fixIterations),
    meanSavingsVsBaselinePct: meanSavings,
    confidenceScore,
  };
}

function medianTokensByTask(
  records: ReadonlyArray<RouteRunRecord>,
  route: RouteName,
): ReadonlyMap<string, number> {
  const buckets = new Map<string, number[]>();
  for (const record of records) {
    if (record.route !== route) continue;
    const values = buckets.get(record.taskId) ?? [];
    values.push(record.ccTokens);
    buckets.set(record.taskId, values);
  }
  return new Map([...buckets.entries()].map(([taskId, values]) => [taskId, median(values)]));
}

function gateRate(rows: ReadonlyArray<RouteRunRecord>): number {
  return ratio(
    rows.filter((row) => {
      if (!row.success) return false;
      if (row.testsPassed === false) return false;
      if (row.reviewPassed === false) return false;
      return true;
    }).length,
    rows.length,
  );
}

function optionalBooleans(values: ReadonlyArray<boolean | undefined>): number | undefined {
  const present = values.filter((value): value is boolean => value !== undefined);
  if (present.length === 0) return undefined;
  return ratio(present.filter(Boolean).length, present.length);
}

function optionalNumbers(values: ReadonlyArray<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  return mean(present);
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function routeOrder(route: RouteName): number {
  return RouteNameSchema.options.indexOf(route);
}
