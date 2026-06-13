# ADR 0004 - Codex Lifecycle Participation Policy

- **Date**: 2026-06-11
- **Status**: Accepted
- **Companion**: ADR 0001 (append-only contracts), ADR 0002 (plugin packaging)

## Context

Build 6 made Codex review visible and warm-cached at pre-commit time. That
solves one quality gate, but it does not make Codex available throughout the
development loop. The desired shape is broader: Codex should be available after
plans, after code application, after failed tests, and after repeated failed
fix attempts, while Composer/Coco stays smart enough to skip tiny work.

## Decision

Add a new optional top-level config block, `codexLifecycle`, separate from:

- `codexReview`: mechanical review and pre-commit gate.
- `codexRescue`: stuck-debug second-opinion lane.

`codexLifecycle` is a deterministic policy surface. It never invokes Codex by
itself. It scores a lifecycle event and returns one of:

- `skip`: do not involve Codex.
- `ask`: ask the user before involving Codex.
- `run`: Codex may participate automatically within configured safety limits.

When the orchestrator receives `ask`, it must pass `confirmed:true` to
`composer_codex_lifecycle_run` after the user agrees. The confirmation only
promotes an `ask` decision; it does not override disabled triggers,
destructive-action skips, or other policy `skip` outcomes.

The policy is exposed through `composer_codex_lifecycle_decide`, a read-only,
idempotent MCP tool. The orchestrator passes compact signals such as changed
files, diff lines, failed attempts, failing tests, risk, security/infra flags,
and whether a shared handoff exists.

Qualified runs use `composer_codex_lifecycle_run`. Foreground execution returns
the result in the same call. Background execution returns a `jobId` and
`resultPath`; the orchestrator must call `composer_codex_lifecycle_result` before
treating the lifecycle step as complete. Result records live outside the project
worktree under Composer user state, by default
`~/.local/state/composer/codex-lifecycle/<project-key>/`, or under
`COMPOSER_STATE_DIR` when that environment variable is set.

Provider/session failures are recorded separately from policy skips. If Codex
cannot run because auth expired, quota/usage is exhausted, rate limits hit,
or the CLI times out, the job status becomes `unavailable` with an
`unavailableReason`. Coco may continue optional lifecycle work after surfacing
that record, but this is not an approval and must not be treated as a deliberate
`skip`.

Lifecycle fallback is explicit config, not implicit fail-open behavior. When
`codexLifecycle.fallback.enabled` is true, Composer first attempts `coderCli`
and then each role in `fallback.order`, recording every provider attempt in the
job. A fallback success is still `succeeded`, with `providerRole` and
`fallbackUsed` showing which role produced the result. If all roles fail, the
job is `unavailable`.

Config changes are exposed through `composer_config_get` and
`composer_config_set` so Claude Code can toggle lifecycle, fallback, and
pre-commit review-gate settings without hand-editing JSON. The setter accepts a
narrow patch surface and validates the full resulting config before writing.
Active-scope reads may resolve to the user-global fallback, but active-scope
writes refuse that implicit global target; callers must request `scope:"global"`
explicitly to mutate user-global config.

Default posture is conservative:

- `enabled:false`
- `mode:"ask"`
- `execution:"background"`
- `model:"gpt-5.4-mini"`
- active triggers: `postPlan`, `postCodeApply`, `postTestFailure`,
  `afterFailedAttempts`
- passive and duplicated review paths off by default: `postResearch`,
  `preCommit`, `stopWarm`
- fallback disabled by default, default order `reviewerClaude`, `reviewer`,
  then `coder` when enabled

## Consequences

Positive:

- Codex can participate across the full development lifecycle without a blanket
  always-dispatch rule.
- The scoring threshold is configurable per project while keeping defaults
  safe for new installs.
- The decision is cheap and testable because it does not call Codex.

Negative:

- Background lifecycle work is only useful if the orchestrator polls the durable
  result and merges it back into the main loop.
- Optional lifecycle work can degrade when Codex is unavailable, but forced
  quality gates remain the responsibility of `codexReview` and should fail
  closed when configured that way.
- Fallback providers can keep the lifecycle useful during Codex quota/auth
  outages, but the result must disclose that fallback was used.
- Orchestrator instructions must keep treating destructive, billing, deploy,
  and secret-handling actions as human-controlled, even when the score is high.
- Lifecycle Codex runs are companion/advisory passes. They must not silently
  mutate files in the background.

## Verification

- `parseConfig` accepts omitted, defaulted, and fully populated
  `codexLifecycle` blocks.
- `composer_codex_lifecycle_decide` returns a JSON decision without invoking a
  provider.
- `composer_codex_lifecycle_run` writes durable foreground/background job
  records.
- `composer_codex_lifecycle_result` retrieves job records by `jobId`, or the
  latest lifecycle record when no `jobId` is supplied.
- Fallback attempts are persisted with role, status, and unavailable reason.
- `composer_config_set` updates active/project/global config only after schema
  validation, and requires explicit `scope:"global"` for user-global writes.
- `agent-composer doctor` reports lifecycle mode, triggers, and thresholds.
