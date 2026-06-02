export interface ProjectOptions {
  maxChars?: number;
  headChars?: number;
  tailChars?: number;
}

export interface ProjectResult {
  text: string;
  projected: boolean;
  originalChars: number;
  keptChars: number;
  kind: "json" | "diff" | "log" | "generic";
}

type ProjectKind = ProjectResult["kind"];

const DEFAULT_MAX_CHARS = 16_000;
const PROJECTED_MARKER = /(?:^|\n)… \[elided \d+ chars \/ \d+ lines\] …(?:\n|$)/;
const JSON_PREFIX = "[projected JSON:";
const LOG_LINE = /^(?:\s*(?:PASS\b|FAIL\b|✓|✗|Error\b)|[^:\n]+:\d+:\d+\b|\s+at [^\n]+:\d+(?::\d+)?\b)/;

interface NormalizedOptions {
  maxChars: number;
  headChars: number;
  tailChars: number;
}

export function projectToolResult(
  input: string,
  opts: ProjectOptions = {},
): ProjectResult {
  if (typeof input !== "string") {
    throw new Error("projectToolResult: input must be a string");
  }

  const options = normalizeOptions(opts);
  const kind = detectKind(input);
  if (input.length === 0 || input.length <= options.maxChars || isAlreadyProjected(input)) {
    return {
      text: input,
      projected: false,
      originalChars: input.length,
      keptChars: input.length,
      kind,
    };
  }

  const text =
    kind === "json"
      ? projectJson(input, options.maxChars)
      : projectText(input, options.headChars, options.tailChars);

  return {
    text,
    projected: true,
    originalChars: input.length,
    keptChars: text.length,
    kind,
  };
}

function normalizeOptions(opts: ProjectOptions): NormalizedOptions {
  const maxChars = normalizeLimit("maxChars", opts.maxChars, DEFAULT_MAX_CHARS);
  const defaultHeadChars = Math.round(maxChars * 0.6);
  const defaultTailChars = Math.round(maxChars * 0.25);
  const headChars = normalizeLimit("headChars", opts.headChars, defaultHeadChars, true);
  const tailChars = normalizeLimit("tailChars", opts.tailChars, defaultTailChars, true);

  return { maxChars, headChars, tailChars };
}

function normalizeLimit(
  name: string,
  value: number | undefined,
  fallback: number,
  allowZero = false,
): number {
  const raw = value ?? fallback;
  if (raw === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(raw)) {
    throw new Error(`projectToolResult: ${name} must be a finite number`);
  }
  const rounded = Math.round(raw);
  if (rounded < 0 || (!allowZero && rounded === 0)) {
    const expectation = allowZero ? "non-negative" : "positive";
    throw new Error(`projectToolResult: ${name} must be ${expectation}`);
  }
  return rounded;
}

function isAlreadyProjected(input: string): boolean {
  return input.startsWith(JSON_PREFIX) || PROJECTED_MARKER.test(input);
}

function detectKind(input: string): ProjectKind {
  const trimmed = input.trim();
  if (trimmed.length > 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Invalid JSON still falls through to text heuristics.
    }
  }

  if (looksLikeDiff(input)) return "diff";
  if (looksLikeLog(input)) return "log";
  return "generic";
}

function looksLikeDiff(input: string): boolean {
  if (/^diff --git /m.test(input) || /^@@ /m.test(input)) return true;
  const plusMinusLines = input
    .split("\n")
    .filter((line) => /^[+-]/.test(line)).length;
  return plusMinusLines >= 6;
}

function looksLikeLog(input: string): boolean {
  return input.split("\n").some((line) => LOG_LINE.test(line));
}

function projectText(input: string, headChars: number, tailChars: number): string {
  const collapsed = collapseRepeatedLines(input);
  const head = collapsed.slice(0, headChars);
  const tailStart = tailChars === 0
    ? collapsed.length
    : Math.max(head.length, collapsed.length - tailChars);
  const middle = collapsed.slice(head.length, tailStart);
  const tail = collapsed.slice(tailStart);
  const marker = `\n… [elided ${middle.length} chars / ${countLines(middle)} lines] …\n`;
  return `${head}${marker}${tail}`;
}

function collapseRepeatedLines(input: string): string {
  const lines = input.split("\n");
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    let count = 1;
    while (index + count < lines.length && lines[index + count] === line) {
      count++;
    }
    collapsed.push(count > 3 ? `${line} … (×${count})` : lines.slice(index, index + count).join("\n"));
    index += count;
  }

  return collapsed.join("\n");
}

function countLines(input: string): number {
  if (input.length === 0) return 0;
  return input.split("\n").length;
}

function projectJson(input: string, maxChars: number): string {
  const parsed = JSON.parse(input.trim()) as unknown;
  const summary = summarizeJson(parsed);
  const sample = JSON.stringify(sampleJson(parsed), null, 2) ?? "";
  const prefix = `${JSON_PREFIX} ${summary}]\n`;
  if (prefix.length >= maxChars) {
    return `${prefix.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  const remaining = maxChars - prefix.length;
  return `${prefix}${truncate(sample, remaining)}`;
}

function summarizeJson(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(length=0)";
    if (depth >= 3) return `array(length=${value.length})`;
    return `array(length=${value.length}, sample=${summarizeJson(value[0], depth + 1)})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "object{}";
    if (depth >= 3) return `object(keys=${entries.length})`;
    const visibleEntries = entries.slice(0, 8).map(
      ([key, entryValue]) => `${key}:${summarizeJson(entryValue, depth + 1)}`,
    );
    const hidden = entries.length - visibleEntries.length;
    const suffix = hidden > 0 ? `,…+${hidden} keys` : "";
    return `object{${visibleEntries.join(",")}${suffix}}`;
  }
  return typeof value;
}

function sampleJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    return value.length > 0 ? [sampleJson(value[0], depth + 1)] : [];
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 8)
      .map(([key, entryValue]) => [key, sampleJson(entryValue, depth + 1)]),
  );
}

function truncate(input: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (input.length <= maxChars) return input;
  if (maxChars === 1) return "…";
  return `${input.slice(0, maxChars - 1)}…`;
}
