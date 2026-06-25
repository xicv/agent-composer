# Composer Self-Evolution Layer

> **Companion to** [`multi_agent_orchestration_plan.md`](./multi_agent_orchestration_plan.md). This doc captures research into autonomous skill creation, self-improving agents, and prompt/skill optimization — and proposes a *minimal*, *opt-in* self-evolution layer that fits Composer's existing two-layer architecture without bloating the orchestrator.

## 1. The concepts the user asked about — verified

### Hermes Agent (Nous Research, Feb 2026)

[Hermes](https://github.com/nousresearch/hermes-agent) is the headline open-source self-evolving agent of 2026. Two core mechanisms are directly relevant to Composer:

| Hermes mechanism | What it does | Composer analogue |
|------------------|--------------|-------------------|
| **Autonomous Skill Creation** | After a complex task, the agent writes a `SKILL_*.md` summarising "what worked, what didn't". Future runs auto-load it. | A `composer-evolve` skill that watches for solved problems and proposes new skill drafts to `~/.claude/skills/`. |
| **Persistent memory + FTS5 session search** | Every session indexed; LLM summarisation makes "did we solve this before?" cheap. | The user already uses `claude-mem` (observed in CLAUDE.md). Composer can piggy-back on its observation index — no need to re-implement. |

### Karpathy `autoresearch` (March 2026)

[karpathy/autoresearch](https://github.com/karpathy/autoresearch) is a 630-line script that ran 700 ML experiments overnight. The pattern is:

```
loop:
  agent.mutate(target_artefact)        # edit prompt / skill / config
  metric = run_timeboxed_eval()        # fixed 5-min budget
  if metric > best: keep else revert
```

Composer's `superpowers:autoresearch` skill ([already installed](#)) follows exactly this loop, scoped to a single Claude Code skill. It's how we make `composer-mastermind.md` itself iteratively better.

### "Google Skill OS"

A `Skill OS` paper from Google was **not found** in May 2026 search results. The user may be remembering one of:

- **CASCADE** (arxiv 2512.23880) — Cumulative Agentic Skill Creation through Autonomous Development and Evolution. Two meta-skills: *continuous learning* and *self-reflection*.
- **EvoSkills** (arxiv 2604.01687) — Skill Generator + Surrogate Verifier co-evolution loop.
- **SkillWeaver** (arxiv 2504.07079) — Web agents that mine successful trajectories into reusable skills.
- **Automated Skill Discovery for Language Agents** (arxiv 2506.04287).

These all share one pattern: **propose → verify → curate**. We adopt it below in lightweight form.

### Anthropic's own "Self-Improving Agent" skill

[`self-improving-agent`](https://mcpmarket.com/tools/skills/self-improving-agent) is the smallest, most pragmatic implementation: when the user corrects Claude, Claude appends the correction to `learnings.md`. Over time the file becomes a personalised constraint manual. No new infra, no metric harness — just disciplined logging.

---

## 2. Three increasing tiers — pick where to start

| Tier | What it does | Cost | Risk |
|------|--------------|------|------|
| **T1 — Passive learning log** | `SessionEnd` hook appends user-corrections to `.claude/learnings/YYYY-MM.md`. `composer-mastermind` reads it on session start. | ~zero | none — just a file |
| **T2 — Proposal-mode skill author** | A `composer-evolve` skill that *drafts* new `.claude/skills/<name>/SKILL.md` files after solved problems. **Drafts go to `proposals/`, user merges manually.** | small | gated by manual merge |
| **T3 — Autoresearch loop on Composer itself** | `superpowers:autoresearch` mutates `composer-mastermind.md` and active worker prompts against an eval set; keeps deltas that improve token usage / task success. | high (runs unattended) | needs guardrails: read-only mutations to `.claude/skills/<name>.candidate.md`, never overwrites live |

**Recommendation: ship T1 with the v2 plan. T2 after one week of usage data. T3 only once an eval set exists.**

---

## 3. T1 — Passive Learning Log (recommended now)

### Files to add

```
.claude/learnings/
   2026-05.md         # auto-appended one-liners
   index.md           # short hand-curated table-of-contents
```

### Hook config (`.claude/settings.json` additions)

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "${workspaceFolder}/scripts/learn.sh" }
        ]
      }
    ]
  }
}
```

### `scripts/learn.sh` (tiny — no LLM call)

```bash
#!/usr/bin/env bash
# Append the last user→assistant correction-shaped exchange to the month's learning log.
# Trigger words: "no", "don't", "wrong", "stop", "actually", "instead".
TRANSCRIPT="$CLAUDE_SESSION_TRANSCRIPT_PATH"
MONTH="$(date +%Y-%m)"
OUT="${workspaceFolder:-.}/.claude/learnings/${MONTH}.md"

mkdir -p "$(dirname "$OUT")"
jq -r '
  .[] | select(.role=="user")
      | select(.content | test("(?i)\\b(no|don.t|wrong|stop|actually|instead)\\b"))
      | "- \(.timestamp): \(.content[0:200] | gsub("\\n";" "))"
' "$TRANSCRIPT" 2>/dev/null >> "$OUT" || true
```

### Mastermind change

Add one line to `composer-mastermind/SKILL.md`:

```markdown
## Prior learnings
@.claude/learnings/index.md
```

That's the whole T1 system. ~30 lines of code, zero LLM calls, builds value passively. Mirrors Anthropic's own `self-improving-agent` skill.

---

## 4. T2 — Proposal-Mode Skill Author (after one week)

`.claude/skills/composer-evolve/SKILL.md`:

```markdown
---
name: composer-evolve
description: After a non-trivial task completes, draft a candidate skill that captures the pattern. Use sparingly — only when the same shape of problem has appeared 2+ times.
---

## Trigger
Invoke after the orchestrator has successfully integrated a multi-step
solution AND a similar problem appears at least twice in
`.claude/learnings/`.

## Output
Write to `.claude/skills/proposals/<kebab-name>.md` (NOT to the live
skills directory). The user reviews and `mv`s it themselves.

## Frontmatter contract
- name: kebab-case
- description: one sentence ending in a verb phrase
- triggers: comma-separated phrases that should auto-load the skill
```

Why proposal-only:

- Skill content lives in Claude's permanent prompt budget. Auto-merging risks unbounded growth.
- Manual review is cheap (1–2 min per proposal) and catches drift.
- Matches `superpowers:writing-skills` discipline (the user already has this skill installed).

---

## 5. T3 — Autoresearch Loop (later, optional)

Only worth it once you have:

1. An **eval set** — say 20 representative tasks ("add endpoint", "fix bug", "refactor file") with success criteria.
2. A **metric** — combination of (a) main-session token count, (b) whether tests pass, (c) human accept/reject.
3. A **mutation target** — exactly one file at a time (`composer-mastermind/SKILL.md` is the natural first target).

The user's installed `superpowers:autoresearch` skill already implements the Karpathy loop. Pseudo-config:

```yaml
target: .claude/skills/composer-mastermind/SKILL.md
mutation_prompt: |
  You are tuning an orchestrator skill. Propose ONE diff that reduces
  main-session tokens without dropping task success. Diff only.
eval:
  set: ./evals/composer.jsonl
  metric: tokens_main_session * (1 - task_success_rate)
  budget_minutes: 5
budget:
  experiments: 20
  parallelism: 1
```

Keep candidates in `*.candidate.md`. Never overwrite the live skill — promote via `mv` after human review.

---

## 6. What NOT to build

After reading the Hermes / EvoSkills / SkillWeaver papers carefully, several flashy features are tempting but mismatched for Composer:

- **Full Hermes-style autonomous skill creation in production** — Composer's value is *predictable delegation*. Unbounded skill generation undermines that.
- **A co-evolving verifier** (EvoSkills' Surrogate Verifier) — overkill for a single user's tool. The user *is* the verifier.
- **Agent Teams for self-improvement** — Anthropic explicitly warns Agent Teams are experimental, token-expensive, with session-resumption bugs. Stay on subagents until 2027.
- **Persistent vector memory** — the user already has `claude-mem` doing this; don't duplicate.

---

## 7. Token-economics view (the user's core concern)

The whole reason for Composer is "don't waste Max5 tokens". Each self-evolution tier must pay for itself:

| Tier | Token cost per session | Expected saving | Net |
|------|------------------------|-----------------|-----|
| T1 (log) | ~0 | small but compounding (avoids repeating the same mistake) | strongly positive |
| T2 (proposals) | ~500 tokens when triggered (rare) | medium (good skills cut future delegation overhead) | positive after week 2 |
| T3 (autoresearch) | runs in dedicated session, doesn't touch interactive Max5 | depends on eval quality | unknown until measured |

T1 is risk-free and ships with v2. T2 and T3 are explicit human decisions.

---

## 8. References (verified 2026-05)

- [Hermes Agent — Nous Research](https://github.com/nousresearch/hermes-agent)
- [Inside Hermes Agent: How a Self-Improving AI Agent Actually Works](https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving)
- [Karpathy autoresearch — GitHub](https://github.com/karpathy/autoresearch)
- [Autoresearch: Karpathy's Minimal "Agent Loop" — Kingy AI](https://kingy.ai/ai/autoresearch-karpathys-minimal-agent-loop-for-autonomous-llm-experimentation/)
- [EvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification (arxiv 2604.01687)](https://arxiv.org/pdf/2604.01687)
- [SkillWeaver: Web Agents Self-Improve by Discovering and Honing Skills (arxiv 2504.07079)](https://arxiv.org/pdf/2504.07079)
- [CASCADE: Cumulative Agentic Skill Creation (arxiv 2512.23880)](https://arxiv.org/pdf/2512.23880)
- [How to Build Self-Improving AI Skills in Claude Code — MindStudio](https://www.mindstudio.ai/blog/self-improving-ai-skills-claude-code)
- [Self-Improving Agent skill on mcpmarket](https://mcpmarket.com/tools/skills/self-improving-agent)
