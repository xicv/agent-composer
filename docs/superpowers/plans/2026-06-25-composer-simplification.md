# Composer Simplification Plan

Executed slice-by-slice via `composer_code_cli` with `composer_review` gates.

## Slice 1 — Honest metric reframe (docs only)

Goal: Reframe the project value proposition around preserving the brain context window, safety, and reviewability; demote broad "save tokens" claims; make `mainSessionTokens` the headline metric.

Files to touch: `README.md`, `docs/STATUS.md`, both `SKILL.md` copies.

Acceptance: `tsc` clean, `vitest` green, and the lead docs now foreground "preserves the brain context window + safety + reviewability", treat token savings as secondary, and surface `mainSessionTokens` as the primary measurement.

Risk: Copy drift between the two `SKILL.md` copies or replacing a measurable claim with vague marketing language.

## Slice 6a — Delete dead code

Goal: Remove the unused provider stub and replace the eval dispatch placeholder with a real assertion or no metric.

Files to touch: provider ID definitions, config schema, `SpendGuardProvider.isPricedProvider`, provider build switch, and the eval file containing `dispatchedCorrectly`.

Acceptance: `tsc` clean, `vitest` green, and no removed provider path remains while dispatch accuracy is either derived from actual dispatch behavior or omitted.

Risk: Removing schema support can break stale local configs; the eval may expose pre-existing dispatch ambiguity that needs to be handled in the same slice.

## Slice 6b — Simplify dispatchHint

Goal: Replace the uncalibrated heuristic in `src/util/dispatchHint.ts` with the rule: dispatch when expected output is greater than 500 tokens OR work touches files outside the orchestrator read window.

Files to touch: `src/util/dispatchHint.ts` and its focused tests.

Acceptance: `tsc` clean, `vitest` green, and the public interface remains unchanged while tests prove both dispatch triggers and the no-dispatch path.

Risk: Existing callers may rely on incidental scoring details rather than the public result shape.

## Slice 4 — Pre-bundled context default

Goal: Bundle relevant file context into the dispatch brief or handoff by default, Aider repo-map style, so executors stop spending turns in a `Read` loop before doing useful work.

Files to touch: dispatch brief/handoff construction code, context selection utilities, executor prompt tests, and related docs if behavior is user-visible.

Acceptance: `tsc` clean, `vitest` green, and a dispatched task receives a default bundled context section with relevant file paths and summaries before executor work begins.

Risk: Bundling too much context can bloat prompts; context selection must stay bounded and reviewable.

## Slice 2 — Tool-surface sweep (full, hard-remove)

Goal: Implement ADR 0010 by hard-removing legacy code tools, consolidating audit and goal tools, and keeping `composer_code_cli` plus `composer_goal_step` as the remaining distinct verbs.

Files to touch: `src/server/toolDescriptions.ts`, `src/server.ts`, dispatch/routing logic, `.claude/agents/*.md`, both `composer-mastermind/SKILL.md` copies, `composer.config.schema.json` if referenced, `scripts/boundary_guard.sh`, `scripts/dispatch_guard.sh`, and `tests/mcp/server.test.ts`.

Acceptance: `tsc` clean, `vitest` green, and the MCP tool list no longer registers the redundant code-lane, audit-lane, or split goal-lane tools; replacement calls work through `composer_code_cli`, `composer_audit({ action })`, `composer_goal({ action })`, and unchanged `composer_goal_step`.

Risk: This is intentionally breaking for external callers, and allowlist or guard references can leave confusing stale denial messages if missed.

## Slice 3 — Flag-gate evolve

Goal: Remove evolve tools from the default daily MCP surface and register them only when `COMPOSER_ENABLE_EVOLVE=1`.

Files to touch: evolve tool registration, server startup/config plumbing, tests for default and enabled registration, and docs that mention the evolve surface.

Acceptance: `tsc` clean, `vitest` green, and evolve tools are absent by default but present when `COMPOSER_ENABLE_EVOLVE=1` is set.

Risk: Hidden assumptions in tests or docs may treat evolve as always available even though the implementation remains in the repo.

## Slice 5 — De-dup composer_disabled()

Goal: Move the copy-pasted `composer_disabled()` shell block from `boundary_guard.sh`, `learn.sh`, `dispatch_guard.sh`, and `precommit_codex_review.sh` into one sourceable `scripts/lib/composer_disabled.sh` without rewriting the fail-closed gate logic.

Files to touch: `scripts/lib/composer_disabled.sh`, `scripts/boundary_guard.sh`, `scripts/learn.sh`, `scripts/dispatch_guard.sh`, `scripts/precommit_codex_review.sh`, and focused shell-hook tests if present.

Acceptance: `tsc` clean, `vitest` green, and all four scripts source the shared helper while preserving the existing fail-closed behavior when Composer is disabled or the helper cannot be loaded.

Risk: Shell portability and path-resolution mistakes could weaken a gate, so this slice must avoid behavioral cleanup beyond the shared helper extraction.
