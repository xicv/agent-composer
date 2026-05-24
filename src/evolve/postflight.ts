// Wave 3 Step 2 — postflight candidate validation via `agy` CLI.
//
// Runs AFTER the evolve loop picks a winning candidate. Asks the
// research LM (Gemini 3.1 via agy) to check the candidate against
// the preflight ecosystem snapshot, looking for references to
// deprecated APIs or now-stale best practices.
//
// Fail-safe: any non-ACCEPT (ambiguous reply, provider error, missing
// verdict) is treated as REJECT. The /evolve command keeps the prior
// `*.candidate.md` for manual review rather than promoting a maybe-bad
// candidate.

import type { IProvider } from "../providers/IProvider.js";
import { s2DenyPrefilter } from "./s2-deny.js";

export interface PostflightInput {
  ecosystem: string;
  candidate: string;
}

export interface Verdict {
  accept: boolean;
  reason: string;
}

export function buildPostflightPrompt(input: PostflightInput): string {
  return [
    "You are a postflight validator. Decide whether a self-evolved skill",
    "candidate is safe to promote, given the current ecosystem snapshot.",
    "",
    "## Ecosystem snapshot",
    input.ecosystem || "(none — preflight failed)",
    "",
    "## Candidate skill",
    input.candidate,
    "",
    "Reject if the candidate references APIs / patterns the snapshot",
    "lists as deprecated or removed. Otherwise accept.",
    "",
    "Reply with the FIRST line being exactly `VERDICT: ACCEPT` or",
    "`VERDICT: REJECT`. Next line(s): one-sentence reason.",
  ].join("\n");
}

const VERDICT_RE = /^\s*VERDICT:\s*(ACCEPT|REJECT)\b/im;

export function parseVerdict(reply: string): Verdict {
  const m = reply.match(VERDICT_RE);
  if (!m) return { accept: false, reason: "no verdict marker in reply (fail-safe REJECT)" };
  const accept = m[1]!.toUpperCase() === "ACCEPT";
  const reason = reply.replace(VERDICT_RE, "").trim() || (accept ? "no reason given" : "rejected");
  return { accept, reason };
}

export async function runPostflight(
  provider: IProvider,
  input: PostflightInput,
): Promise<Verdict> {
  // ADR 0003 S2: deterministic deny-pattern prefilter runs BEFORE the LLM
  // researcher. Short-circuits on any escalation primitive or boundary-
  // bypass directive — the LLM cannot be prompt-injected to accept these
  // because the LLM is never called on these candidates.
  const s2 = s2DenyPrefilter(input.candidate);
  if (!s2.allowed) {
    return { accept: false, reason: s2.reason ?? "S2 deny-pattern matched" };
  }
  const prompt = buildPostflightPrompt(input);
  try {
    const out = await provider.execute({ prompt });
    return parseVerdict(out.text);
  } catch (err) {
    return {
      accept: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
