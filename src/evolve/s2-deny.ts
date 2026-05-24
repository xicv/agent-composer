// ADR 0003 S2 — deterministic deny-pattern prefilter for self-evolution.
//
// Runs BEFORE the LLM postflight researcher (agy CLI). Any regex hit is an
// automatic reject — the LLM cannot be talked out of these via prompt
// injection because the LLM is never called. The four-layer stat-gate also
// continues to apply, but S2 short-circuits ahead of S3 layer 3.
//
// The deny list is intentionally narrow: only escalation primitives and
// boundary-bypass directives that have NO legitimate place in an
// orchestrator skill. Current SKILL.md contains zero matches, verified at
// the time S2 shipped (HEAD ~de3ad2b).

export interface S2Pattern {
  /** Stable identifier used in the reject reason. */
  id: string;
  /** Pattern to test against the candidate text. */
  pattern: RegExp;
  /** Human-readable description of why this pattern is denied. */
  description: string;
}

export const S2_DENY_PATTERNS: ReadonlyArray<S2Pattern> = [
  {
    id: "rm-rf",
    pattern: /\brm\s+-[rf]+[rf]\s+/i,
    description: "rm -rf — destructive recursive remove",
  },
  {
    id: "sudo",
    pattern: /\bsudo\s+\w/i,
    description: "sudo invocation — privilege escalation",
  },
  {
    id: "chmod-777",
    pattern: /\bchmod\s+777\b/,
    description: "chmod 777 — world-writable permissions",
  },
  {
    id: "curl-pipe-shell",
    pattern: /\bcurl\b[^\n]*\|\s*(?:sh|bash|zsh)\b/i,
    description: "curl | sh — remote code execution primitive",
  },
  {
    id: "wget-pipe-shell",
    pattern: /\bwget\b[^\n]*\|\s*(?:sh|bash|zsh)\b/i,
    description: "wget | sh — remote code execution primitive",
  },
  {
    id: "dangerously-skip-permissions",
    pattern: /--dangerously-skip-permissions/,
    description: "claude flag that disables permission gating",
  },
  {
    id: "boundary-bypass-env",
    pattern: /COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS\s*=\s*["']?(?:1|true)["']?/i,
    description: "boundary_guard.sh bypass env var assignment",
  },
  {
    id: "boundary-disable-directive",
    pattern: /\b(?:disable|bypass|ignore|skip|circumvent)\b[^\n]{0,60}\bboundary[_-]?guard\b/i,
    description: "natural-language directive to disable the boundary guard",
  },
];

export interface S2Result {
  allowed: boolean;
  /** Stable id of the first matching pattern, if any. */
  matchedPatternId?: string;
  /** Human-readable reason — same shape as Verdict.reason from postflight. */
  reason?: string;
}

/**
 * Test a candidate skill string against the S2 deny list.
 * Returns `{ allowed: true }` if no pattern matches; otherwise the first
 * match's id and a formatted reason.
 *
 * The order of patterns in {@link S2_DENY_PATTERNS} is deterministic; the
 * function returns on the first match, so put more-specific patterns first
 * if precision matters.
 */
export function s2DenyPrefilter(candidate: string): S2Result {
  for (const p of S2_DENY_PATTERNS) {
    if (p.pattern.test(candidate)) {
      return {
        allowed: false,
        matchedPatternId: p.id,
        reason: `S2 deny-pattern matched: ${p.id} (${p.description})`,
      };
    }
  }
  return { allowed: true };
}
