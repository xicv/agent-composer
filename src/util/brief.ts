import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

export const BRIEF_DIR = ".composer/briefs";

export const SliceSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  note: z.string().optional(),
});

export const BriefSchema = z.object({
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  task: z.string().min(1),
  files: z.array(z.string().min(1)),
  symbols: z.array(z.string().min(1)).optional(),
  deps: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  slices: z.array(SliceSchema),
});

export type Slice = z.infer<typeof SliceSchema>;
export type Brief = z.infer<typeof BriefSchema>;

export function newBrief(task: string): Brief {
  return BriefSchema.parse({
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    task,
    files: [],
    slices: [],
  });
}

export function writeBrief(brief: Brief, dir = BRIEF_DIR): string {
  const validated = BriefSchema.parse(brief);
  const absDir = resolve(dir);
  mkdirSync(absDir, { recursive: true });
  const path = resolve(absDir, `${validated.runId}.json`);
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf8");
  return path;
}
