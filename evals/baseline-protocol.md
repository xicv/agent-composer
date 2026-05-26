# Baseline Measurement Protocol

> Companion to [`SUCCESS.md`](./SUCCESS.md) and [`../docs/STATUS.md`](../docs/STATUS.md). Defines how to measure `baselineMainTokens` — the load-bearing comparator for the token-component of the eval metric (plan §7, 30% weight).

## What we are measuring

For each task in `tasks.jsonl`: **how many tokens does stock Claude Max5 spend in the *main session* (no Composer skill, no subagents, no MCP composer server, no boundary_guard hook) to satisfy the same prompt?**

This is the denominator. Composer's pitch is that it reduces this number ≥ 50% via subagent delegation. Without a baseline, "did we save tokens?" is unanswerable.

## Pre-flight

- Composer should NOT be loaded. Two options:
  1. **Sibling worktree** (recommended): `git worktree add ../composer-baseline main && cd ../composer-baseline && rm -rf .claude` so the Composer hook/skill/subagents are absent. Or:
  2. **In-place + disable**: temporarily rename `.claude/` to `.claude.disabled/` for the measurement run, restore after.
- Confirm baseline session is clean: ask Claude "do you have a composer-mastermind skill loaded?" — it should say no.
- Make sure `/usage` is available (Claude Code 2026.04+).

## Procedure

For each of the 3 tasks in `tasks.jsonl`:

1. **Start a fresh Claude Code session** in the baseline tree.
2. Open a new conversation. Paste the task's `prompt` field verbatim.
3. Let Claude work end-to-end. Do NOT correct, refine, or interrupt — we are measuring stock behaviour.
4. When Claude reports done, run `/usage` (or check the transcript for token totals).
5. Record:
   - `mainSessionTokens` — the **input + output** tokens consumed by the main session for this task. This is the user-facing context cost.
   - `wallSeconds` — wall-clock time from prompt to "done".
   - `method` — short note on how you captured tokens (`/usage`, transcript JSON, etc).
   - `notes` — any behaviour worth flagging for the autoresearch loop.

## Output format

Write to `evals/baselines.json`. Schema mirrors `baselines.example.json`:

```json
{
  "measuredAt": "2026-05-23T19:00:00Z",
  "measuredBy": "<your-handle>",
  "claudeModel": "claude-opus-4-7",
  "claudeCodeVersion": "<output of: claude --version>",
  "baselines": {
    "t1-slugify": {
      "mainSessionTokens": 4500,
      "wallSeconds": 80,
      "method": "/usage at end of session",
      "notes": "Wrote slug.ts + 3 tests. No false starts."
    },
    "t5-review-catch-off-by-one": { ... },
    "t7-refuse-out-of-scope":      { ... }
  }
}
```

## Re-measurement triggers

Baselines are frozen once recorded. Re-measure only when:

- The Claude orchestrator model changes by a major version (Opus 4.7 → next).
- The eval task wording in `tasks.jsonl` changes materially (cosmetic edits don't count).
- A finding shows the baseline was contaminated (e.g. Composer was actually loaded during measurement).

When re-measuring, commit a new `baselines.json` and update `measuredAt`. Autoresearch trend lines reset.

## What to commit

```
git add evals/baselines.json
git commit -m "chore: record stock-Claude baselines for 3 starter eval tasks"
```

`baselines.json` is NOT a secret — token counts are not sensitive. It's gitignore-clear by default.

## Cost

User-side time only, ~5 minutes per task on Max5. Zero out-of-pocket spend.
