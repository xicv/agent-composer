// Wave 3 Step 2 — GEPA reflect_and_rewrite via GLM 5.1.
//
// The reflection LM sees: the parent skill, the failing task
// transcripts, and the preflight ecosystem snapshot. It returns a
// candidate rewrite. Temperature is fixed at 0 by the provider layer
// (AnthropicCompatibleProvider passes through whatever the request
// says; runner sets temperature=0 once per loop).
//
// Errors here ARE fatal to a candidate — unlike preflight/postflight
// (best-effort), if the mutator itself can't produce a rewrite, the
// runner should skip this round, not promote anything.

import type { IProvider } from "../providers/IProvider.js";

export interface TaskTranscript {
  task: string;
  outcome: string;
}

export interface AuditFailure {
  route?: string;
  taskClass?: string;
  reviewVerdict?: string;
  status?: string;
  userCorrection?: boolean;
  note?: string;
}

export interface ReflectionInput {
  parent: string;
  taskTranscripts: ReadonlyArray<TaskTranscript>;
  currentEcosystem?: string;
  auditFailures?: ReadonlyArray<AuditFailure>;
}

export function buildReflectionPrompt(input: ReflectionInput): string {
  const lines: string[] = [
    "You are a GEPA reflection mutator. Rewrite the parent skill so the",
    "listed failures would have been avoided. Keep the same overall",
    "structure and length budget. Reply with ONLY the rewritten skill",
    "body (no preamble, no fenced block).",
    "",
    "## Parent skill",
    input.parent,
    "",
    "## Recent failing transcripts",
  ];
  for (const t of input.taskTranscripts) {
    lines.push(`- task: ${t.task}`);
    lines.push(`  outcome: ${t.outcome}`);
  }
  if (input.auditFailures && input.auditFailures.length > 0) {
    lines.push("", "## Recent route/audit failures (real outcomes from the audit trail)");
    lines.push("Bias the rewrite to avoid these: wrong route choice, unnecessary Oracle use, issues a review caught after the fact, and routes the user corrected.");
    for (const f of input.auditFailures.slice(0, 10)) {
      const bits = [
        f.route && `route=${f.route}`,
        f.taskClass && `class=${f.taskClass}`,
        f.status && `status=${f.status}`,
        f.reviewVerdict && `review=${f.reviewVerdict}`,
        f.userCorrection ? "user-corrected" : undefined,
      ].filter(Boolean).join(" ");
      lines.push(`- ${bits}${f.note ? ` — ${f.note}` : ""}`);
    }
  }
  if (input.currentEcosystem && input.currentEcosystem.trim().length > 0) {
    lines.push("", "## Current ecosystem", input.currentEcosystem);
  }
  return lines.join("\n");
}

const FENCE_RE = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/;

export async function reflectViaProvider(
  provider: IProvider,
  input: ReflectionInput,
): Promise<string> {
  const prompt = buildReflectionPrompt(input);
  const out = await provider.execute({ prompt });
  const trimmed = out.text.trim();
  const m = trimmed.match(FENCE_RE);
  return m ? m[1]!.trim() : trimmed;
}
