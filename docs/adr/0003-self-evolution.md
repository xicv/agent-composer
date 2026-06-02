# ADR 0003 — Self-Evolution Surface: What `/evolve` Is Allowed to Mutate

- **Date**: 2026-05-24
- **Status**: Draft (stub — codifies Wave 3 learnings, locks contract for Wave 4)
- **Supersedes**: none
- **Companion**: ADR 0001 §"Amendments → Wave-3 Step 1 (boundary_guard extensions)" — safety primitives; this ADR is the **scope contract** they enforce.

## Context

Wave 3 shipped the GEPA-lite autoresearch loop (`scripts/run-evolve.ts` + `src/evolve/*` + `.claude/commands/evolve.md`). Today's 4 real-mode runs (HEAD `c708640`) demonstrated that the loop is mechanically safe (Build 4 worktree sandbox), per-task resilient (commit `3e68db2`), stat-gate guarded (`00cc3cf`), and diagnostically observable. The infrastructure is unattended-safe.

But the *scope* of what `/evolve` is allowed to change has not been formally pinned. The Wave-3 Step 1 amendment to ADR 0001 introduced `COMPOSER_STOP_EVOLVE_FILE` (kill switch) and the diff-whitelist regex in `scripts/evolve_check_diff.sh`, but those are mechanism, not contract. This ADR is the contract: **what counts as a legitimate `/evolve` mutation, and what is out of bounds.**

This matters most when the plugin ships (ADR 0002): consumer projects must trust that running `/evolve` cannot quietly broaden the orchestrator's authority, weaken its safety hooks, or introduce code-execution paths the user did not opt into.

## Decision

`/evolve` mutations are constrained by **three layered scopes**: diff-path scope (mechanical), text-content scope (semantic), and promotion-gate scope (statistical). All three must pass for a candidate to be promoted.

### S1 — Diff-path scope (mechanical, enforced by `evolve_check_diff.sh`)

`/evolve` may only emit candidate text into files matching the regex set already locked in ADR 0001 amendment:

```
^\.claude/agents/[^/]+\.md$
^\.claude/skills/composer-mastermind/SKILL\.md$
^evals/tasks/[^/]+\.json$
^evals/tasks\.jsonl$
```

This ADR **adds no new paths** to that whitelist. Future expansion requires a new ADR with explicit rationale.

The PR-gate script `scripts/evolve_check_diff.sh` runs in CI on any branch named `evolve/*` and rejects merges that touch files outside this set. Locally, the `/evolve` loop only writes `.claude/skills/composer-mastermind/SKILL.candidate.md` — promotion to `SKILL.md` is a human `mv`. Both mechanisms must be in place.

### S2 — Text-content scope (semantic, enforced by postflight researcher)

Inside the orchestrator SKILL.md, certain text patterns are **always disallowed** in any candidate, regardless of stat-gate verdict:

- Any string matching `(rm -rf|sudo|chmod 777|curl.*\| ?sh|wget.*\| ?bash)` — escalation primitives.
- Any directive that removes a subagent from the locked C0.5 tools allowlists (C0.5 is append-only).
- Any directive that disables, bypasses, or rewrites `boundary_guard.sh` behaviour ("ignore the deny list", "use `--dangerously-skip-permissions`", etc).
- Any directive that broadens `boundary_guard.sh` allowed tool surface beyond the Composer MCP tool set + Read/Glob.

The agy CLI postflight researcher (deps.researchProvider in `runEvolve`) checks for these patterns and emits `accept: false` with a quoted offending substring. This has fired 4-of-5 real runs to date on substantive grounds; this ADR formalizes the deny list it should expand to enforce.

Open implementation work: the postflight check is currently advisory text-based. S2 will harden it by adding a deterministic regex prefilter that runs before the LLM researcher — any regex hit is automatic reject with `reason: "S2 deny-pattern matched: <pattern>"`.

### S3 — Promotion-gate scope (statistical, enforced by `candidateBeatsParent` + re-run survival)

A candidate is promoted only if **all four** stat-gate layers pass:

1. **CI-disjoint** (`ci95(candidate).lower > ci95(parent).upper`) OR Wilcoxon p < 0.1 (paired-length precondition required — guarded by `00cc3cf`).
2. **Re-run survival** — candidate is re-evaluated N times (default 3) on the train+val split; survival-set CI must also beat parent.
3. **Postflight S2 check** — text deny-list + LLM researcher (agy CLI) both `accept: true`.
4. **Length-lambda penalty** — `score - lambda * char_count` applied; promotes only if penalty-adjusted score still beats parent.

Today's 4 real runs all stopped at layer 1 or 3. The four-layer gate is doing exactly what it should — refuse promotion on insufficient signal, ecosystem-deprecated patterns, or both.

### S4 — Permanence boundary

`/evolve` writes only to `.candidate.md` files. Promotion to the canonical `SKILL.md` requires a **human `mv` operation** (or a Wave 4 promote command that records git-blame metadata). This ADR prohibits auto-promotion. Reason: every promotion is a change to the runtime brain; the trust boundary for that change is a human commit, not an automated loop.

### S5 — Audit trail

Every `/evolve` run that produces a candidate (whether promoted or not) appends one row to `docs/STATUS.md` "Dogfood audit log" or its successor table — minimum fields: date, command, parent/candidate scores, postflight verdict, promoted yes/no. Today's STATUS.md sections under "First/Second/Third real /evolve run" + "Fourth (failed) and sixth real /evolve runs" are the precedent.

In Wave 4 (plugin distribution), consumer projects MAY redact the audit row but MUST emit it locally. This is the only telemetry obligation the plugin places on consumers.

## Consequences

**Positive**:
- Trust boundary for skill mutation is explicit and layered: mechanical (diff path), semantic (content patterns), statistical (promotion gate), and human (manual promote).
- The four resilience layers shipped 2026-05-24 collectively satisfy S3's mechanical requirements; no new infrastructure needed.
- Consumers of the published plugin (ADR 0002) inherit S1–S5 unchanged; the orchestrator brain cannot quietly grow new capabilities in their projects.

**Negative**:
- S2 regex prefilter is not yet implemented (advisory text in postflight only). This is the only meaningful work item this ADR creates.
- S4's "human promotion required" trade-off: a fully-autonomous improvement loop is permanently off the table by this ADR. Acceptable cost for trust.

## Verification (Wave 4 acceptance criteria)

- S1: `scripts/evolve_check_diff.sh` blocks a PR that touches `src/` in an `evolve/*` branch — test in CI.
- S2: a candidate containing `rm -rf` in SKILL.md is auto-rejected with the deny-pattern reason — unit test in `tests/evolve/postflight.test.ts`.
- S3: existing `tests/evolve/pareto.test.ts` (288 vitest, today) covers the stat layers.
- S4: no automated path in `scripts/run-evolve.ts` calls `mv SKILL.candidate.md SKILL.md` — grep-test in CI.
- S5: every `/evolve` real-mode run produces a STATUS.md diff (or new audit-log artifact) — manual gate via PR review until automated.

## References

- [ADR 0001](./0001-contracts.md) §"Wave-3 Step 1 amendment" — `COMPOSER_STOP_EVOLVE_FILE` killswitch + diff whitelist regex (the mechanism S1 enforces).
- [`docs/STATUS.md`](../STATUS.md) — current state (HEAD `c708640`); 4 real-mode runs all stopped at S3 layers, validating the design.
- [`scripts/run-evolve.ts`](../../scripts/run-evolve.ts) §`createRealEvaluate` — sandbox + resilience layers (Build 4 + `3e68db2` + `00cc3cf`).
- [`src/evolve/pareto.ts`](../../src/evolve/pareto.ts) §`candidateBeatsParent` — S3 implementation.
- [`docs/self_evolving_composer.md`](../self_evolving_composer.md) §2 (T1/T2/T3 tiers — this ADR pins where each tier is allowed to mutate).

## Open questions (deferred to Wave 4)

1. **S2 LLM-postflight robustness.** Adversarial prompts could persuade the agy researcher to accept a deny-pattern candidate. The regex prefilter is the deterministic backstop. Question: when prefilter and LLM disagree, which wins? Default: prefilter (always-deny). This ADR commits to that default.
2. **S5 in airgapped consumer projects.** If a plugin consumer disables outbound network, postflight (agy CLI) is impossible. Should S3 layer 3 degrade gracefully (skip postflight, refuse all promotions) or fail loudly? Default: refuse all promotions if postflight unavailable; loud "research provider unreachable" error.
3. **`/evolve` on the plugin itself.** Should consumer-project `/evolve` ever propose mutations to the *published plugin* (vs project-local SKILL.md override)? Default: never. Plugin updates are out-of-band via npm/git, never via `/evolve`. This ADR commits to that.
