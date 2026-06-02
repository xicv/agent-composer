import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

export const HANDOFF_DIR = ".composer/handoffs";
export const HANDOFF_VERSION = 1;

export const HandoffArtifactSchema = z.object({
  kind: z.enum(["research", "code", "review", "test", "note"]),
  summary: z.string().min(1),
  path: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
});

export const HandoffPacketSchema = z.object({
  version: z.literal(HANDOFF_VERSION),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  objective: z.string().min(1),
  contextSummary: z.string().min(1).optional(),
  constraints: z.array(z.string().min(1)),
  relevantFiles: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
  decisions: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  artifacts: z.array(HandoffArtifactSchema),
  briefPath: z.string().min(1).optional(),
});

export type HandoffArtifact = z.infer<typeof HandoffArtifactSchema>;
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

export interface NewHandoffPacketInput {
  objective: string;
  contextSummary?: string;
  constraints?: string[];
  relevantFiles?: string[];
  acceptanceCriteria?: string[];
  decisions?: string[];
  openQuestions?: string[];
  artifacts?: HandoffArtifact[];
  briefPath?: string;
}

export function newHandoffPacket(input: NewHandoffPacketInput): HandoffPacket {
  const now = new Date().toISOString();
  return HandoffPacketSchema.parse({
    version: HANDOFF_VERSION,
    runId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    objective: input.objective,
    contextSummary: input.contextSummary,
    constraints: input.constraints ?? [],
    relevantFiles: input.relevantFiles ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    decisions: input.decisions ?? [],
    openQuestions: input.openQuestions ?? [],
    artifacts: input.artifacts ?? [],
    briefPath: input.briefPath,
  });
}

export function writeHandoffPacket(
  packet: HandoffPacket,
  dir = HANDOFF_DIR,
): string {
  const validated = HandoffPacketSchema.parse(packet);
  const absDir = resolve(dir);
  mkdirSync(absDir, { recursive: true });
  const filePath = resolve(absDir, `${validated.runId}.json`);
  writeFileSync(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return filePath;
}

export function readHandoffPacket(
  handoffPath: string,
  root = process.cwd(),
): HandoffPacket {
  const absRoot = resolve(root);
  const absHandoffDir = resolve(absRoot, HANDOFF_DIR);
  const absPath = resolve(absRoot, handoffPath);
  if (!isInside(absHandoffDir, absPath)) {
    throw new Error(
      `handoffPath must resolve under ${HANDOFF_DIR}; got ${handoffPath}`,
    );
  }
  const realHandoffDir = realpathSync(absHandoffDir);
  const realPath = realpathSync(absPath);
  if (!isInside(realHandoffDir, realPath)) {
    throw new Error(
      `handoffPath must resolve under ${HANDOFF_DIR}; got ${handoffPath}`,
    );
  }
  const raw = readFileSync(realPath, "utf8");
  return HandoffPacketSchema.parse(JSON.parse(raw));
}

export function formatHandoffForPrompt(packet: HandoffPacket): string {
  const lines = [
    "Shared handoff:",
    `- runId: ${packet.runId}`,
    `- objective: ${packet.objective}`,
  ];
  if (packet.contextSummary) lines.push(`- context: ${packet.contextSummary}`);
  pushList(lines, "constraints", packet.constraints);
  pushList(lines, "relevantFiles", packet.relevantFiles);
  pushList(lines, "acceptanceCriteria", packet.acceptanceCriteria);
  pushList(lines, "decisions", packet.decisions);
  pushList(lines, "openQuestions", packet.openQuestions);
  if (packet.briefPath) lines.push(`- briefPath: ${packet.briefPath}`);
  if (packet.artifacts.length > 0) {
    lines.push("- artifacts:");
    for (const artifact of packet.artifacts) {
      const source = artifact.source ? ` (${artifact.source})` : "";
      const path = artifact.path ? ` [${artifact.path}]` : "";
      lines.push(`  - ${artifact.kind}${source}${path}: ${artifact.summary}`);
    }
  }
  return lines.join("\n");
}

function pushList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`- ${label}:`);
  for (const value of values) {
    lines.push(`  - ${value}`);
  }
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  const normalizedChild = child.endsWith("/") ? child : child;
  return normalizedChild === parent || normalizedChild.startsWith(normalizedParent);
}
