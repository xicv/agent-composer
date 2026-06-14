# ADR 0008 - Goal Substrate

- **Date**: 2026-06-14
- **Status**: Accepted
- **Companion**: ADR 0001 (contracts), ADR 0004 (codex lifecycle), ADR 0007 (audit trail)

## Context

Claude Code `/goal` is useful for keeping a session oriented, but its evaluator does not call tools. It judges only the transcript it can see. Composer needs a project-local substrate that can track deterministic verification results, persist richer state, and surface verdicts back to the orchestrator instead of treating transcript judgment as proof.

The substrate also needs to compose with Codex `/goal` semantics: a goal can be active, blocked, achieved, failed, or cancelled, and it must enforce maxTurns and maxCost gates so orchestration cannot drift indefinitely.

## Decision

Add a project-local goal store under `.composer/goals/<goalId>.json` and expose it through Wave 1 utility functions, followed by MCP and CLI surfaces in Wave 2. Goal records are zod-validated, keep objective and condition immutable after creation, and support deterministic verification checks declared by the user or orchestrator. Check commands are stored as data; the orchestrator runs them and reports outcomes through `signals.checkResults`.

### Key design choices

1. **Transcript judgment is not verification.**
   - Rationale: Claude Code `/goal` does not run tools, so it cannot prove tests, builds, or other commands passed. Composer records orchestrator-reported pass/fail status for declared checks, then surfaces the result to the transcript.

2. **State machine mirrors Codex `/goal` budget/state.**
   - States are `active`, `blocked`, `achieved`, `failed`, and `cancelled`.
   - `maxTurns` and optional `maxCost` gates block the goal and ask the user when the budget is exceeded.
   - `active` and `blocked` are open states; `achieved`, `failed`, and `cancelled` are terminal states. `blocked` is resumable, while `composer_goal_step` refuses terminal goals.

3. **`composer_goal_step` is advisory only.**
   - It consumes orchestrator-reported check results and returns the next recommended action. If checks are pending, step returns `composer_goal_status` with `manualChecks` naming the pending checks (no command strings). The orchestrator reads the commands from `composer_goal_status`, runs them deliberately, and reports results via `composer_goal_step`. It never starts workers, never mutates source files, and never executes shell.
   - Rationale: this preserves operator control, prevents runaway loops, follows SGH structured-graph immutability by keeping objective and condition fixed within a goal version, and matches the north star: the orchestrator/brain executes while the substrate tracks state and budget.

### Pending-check next action

Pending checks create a three-way constraint conflict. The next action must be a real callable tool, non-mutating, and not a blind status loop. No separate tool satisfies all three: a hypothetical manual-check tool would not be callable, `composer_goal_step` mutates goal state, and a bare status action could look like a loop.

The chosen resolution is `composer_goal_status` plus `manualChecks`. `composer_goal_status` is real and read-only, and it is the tool that surfaces the declared check commands. The orchestrator reads those commands, runs them out-of-band, then reports results through `composer_goal_step` with `--check-result name=pass|fail`. This is not a blind status loop because real check work happens between the status read and the next step call.

4. **Dual-loop escalation follows CVE2PoC.**
   - Tactical loop: failing check results normally route to `composer_code_cli`; two or more failed attempts route to `composer_codex_lifecycle_run` for rescue.
   - Strategic loop: explicit stuck signals or lack of check progress by the midpoint route to `composer_oracle_plan` for replanning.

5. **One active goal per project.**
   - Rationale: this matches Claude Code `/goal` one-per-session behavior and avoids competing orchestration loops over the same project state.

6. **Check commands are data, not execution.**
   - Checks are command strings for the orchestrator to run in the project root. The substrate stores those strings and consumes reported results only.
   - Because `composer_goal_step` never executes shell, its tool metadata is closed-world and non-destructive even though it mutates the goal record.
   - This removes planted-shell-execution capability and avoids blocking the MCP handler with synchronous command execution.

## Consequences

Positive:
- Composer can prove goal progress with deterministic checks that a transcript-only evaluator cannot run, while keeping execution in the orchestrator.
- Goal state becomes durable across orchestrator turns and worker handoffs.
- Advisory stepping keeps execution under orchestrator/user control while still producing concrete next actions.
- Budget gates and dual-loop escalation make repeated failures explicit instead of silent drift.
- Blocked goals can resume when the orchestrator supplies a `budgetExtension` that raises `maxTurns` or `maxCost`.

Negative:
- The orchestrator must run pending check commands and report results through `signals.checkResults`; the substrate will not verify command output itself.
- The orchestrator must call the step function/tool explicitly; no passive background evaluator updates goal state.
- `maxCost` is advisory. The substrate does not observe provider spend directly, so the orchestrator must feed `spentUsd` through step signals.
- Check-less goals have no deterministic command signal. They depend on the Claude Code `/goal` evaluator, via `conditionMet`, reading the transcript and asserting the condition holds.

### Accepted trade-off: caller-attested completion

The advisory-pure substrate does not execute or independently verify check commands. This is a deliberate security decision: a non-executing tracker must not also be a shell executor. Consequently, completion via `signals.checkResults` is caller-attested. The substrate trusts the orchestrator's reported pass/fail result, which sits at the same trust boundary as the orchestrator running any command.

Deterministic verification is the orchestrator's responsibility. The substrate tracks turns, budget, state, and verdicts, then surfaces the next advisory action. A buggy or dishonest caller can report false results; this is accepted because the alternative, having the substrate execute shell, was explicitly rejected. A non-executing tracker cannot also be a self-verifier; the two properties are mutually exclusive.
