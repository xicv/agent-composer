// Wave 3 Step 2 — preflight ecosystem snapshot via `agy` CLI (Gemini 3.1).
//
// Runs ONCE per /evolve session before any mutation. Result is surfaced
// into the reflection LM as `currentEcosystem` so mutators see what
// changed (new APIs, deprecations, best-practice shifts).
//
// Best-effort: if the CLI fails (network down, agy unavailable), we
// return an empty snapshot — the evolve loop continues without
// ecosystem grounding rather than refusing to run.

import type { IProvider } from "../providers/IProvider.js";

export interface PreflightInput {
  skillDomain: string;
  lastEvolveDate?: string;
}

export interface PreflightSnapshot {
  text: string;
  prompt: string;
  fetchedAt: string;
  error?: string;
}

export function buildPreflightPrompt(input: PreflightInput): string {
  const since = input.lastEvolveDate ?? "never";
  return [
    `Research task: what changed in "${input.skillDomain}" since ${since}?`,
    "",
    "Focus on:",
    "- newly released or stabilised APIs / SDK versions",
    "- deprecations and breaking changes",
    "- best-practice shifts the community has adopted",
    "",
    "Reply with a concise bulleted summary (≤ 25 bullets). No prose intro.",
  ].join("\n");
}

export async function runPreflight(
  provider: IProvider,
  input: PreflightInput,
): Promise<PreflightSnapshot> {
  const prompt = buildPreflightPrompt(input);
  const fetchedAt = new Date().toISOString();
  try {
    const out = await provider.execute({ prompt });
    return { text: out.text, prompt, fetchedAt };
  } catch (err) {
    return {
      text: "",
      prompt,
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
