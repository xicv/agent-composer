import { resolve } from "node:path";

import {
  BRIEF_DIR,
  BriefSchema,
  SliceSchema,
  newBrief,
  writeBrief,
  type Brief,
} from "./brief.js";

export interface ContextSelectionInput {
  task: string;
  files?: string[];
  symbols?: string[];
  deps?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  slices?: Array<{
    file: string;
    startLine?: number;
    endLine?: number;
    note?: string;
  }>;
}

export interface ContextSelection {
  brief: Brief;
  metrics: {
    fileCount: number;
    sliceCount: number;
    symbolCount: number;
    dependencyCount: number;
  };
}

export function selectContext(input: ContextSelectionInput): ContextSelection {
  const task = requiredText(input.task, "task");
  const slices = normalizeSlices(input.slices ?? []);
  const files = unique([
    ...normalizeTextArray(input.files ?? []),
    ...slices.map((slice) => slice.file),
  ]);
  const symbols = optionalUnique(input.symbols);
  const deps = optionalUnique(input.deps);
  const constraints = optionalUnique(input.constraints);
  const acceptanceCriteria = optionalUnique(input.acceptanceCriteria);
  const brief = {
    ...newBrief(task),
    files,
    ...(symbols ? { symbols } : {}),
    ...(deps ? { deps } : {}),
    ...(constraints ? { constraints } : {}),
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    slices,
  };

  return {
    brief: BriefSchema.parse(brief),
    metrics: {
      fileCount: files.length,
      sliceCount: slices.length,
      symbolCount: symbols?.length ?? 0,
      dependencyCount: deps?.length ?? 0,
    },
  };
}

export function writeContextSelectionBrief(
  selection: ContextSelection,
  root = process.cwd(),
): string {
  return writeBrief(selection.brief, resolve(root, BRIEF_DIR));
}

function normalizeSlices(input: ContextSelectionInput["slices"]): Brief["slices"] {
  const seen = new Set<string>();
  const out: Brief["slices"] = [];
  for (const raw of input ?? []) {
    const slice = SliceSchema.parse({
      file: requiredText(raw.file, "slice.file"),
      startLine: raw.startLine,
      endLine: raw.endLine,
      note: optionalText(raw.note),
    });
    if (
      slice.startLine !== undefined &&
      slice.endLine !== undefined &&
      slice.endLine < slice.startLine
    ) {
      throw new Error(`slice endLine must be >= startLine for ${slice.file}`);
    }
    const key = `${slice.file}\0${slice.startLine ?? ""}\0${slice.endLine ?? ""}\0${slice.note ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slice);
  }
  return out;
}

function optionalUnique(values: string[] | undefined): string[] | undefined {
  const normalized = normalizeTextArray(values ?? []);
  return normalized.length > 0 ? unique(normalized) : undefined;
}

function normalizeTextArray(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
