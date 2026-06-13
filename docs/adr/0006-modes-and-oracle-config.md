# ADR 0006 - Modes and Oracle Config Profiles

- **Date**: 2026-06-13
- **Status**: Accepted
- **Companion**: ADR 0004 (codex lifecycle), ADR 0005 (oracle planning lane)

## Context

Operators and developers need a way to shift the entire Codex lifecycle + review gate posture in one command without hand-editing JSON fields. Three recurring postures are observed in practice: skip all gates for speed (fast), polite advisory mode (balanced), and strict fail-closed enforcement (strict).

Separately, a parallel change introduces a top-level `oracle` behavior block (`defaultMode`, `requireExplicitTag`) and a `codexProfiles` map, wired through the Oracle planning lane (ADR 0005).

## Decision

### Built-in modes

Add three named presets — `fast`, `balanced`, `strict` — implemented in `src/config/modes.ts`. Modes are a pure function from name to a `ModePatch` over `codexLifecycle` and `codexReview` only:

| Mode     | codexLifecycle.enabled | codexLifecycle.mode | codexReview.enabled | preCommitHook.failClosed |
|----------|------------------------|---------------------|---------------------|--------------------------|
| fast     | false                  | —                   | false               | false (hook disabled)    |
| balanced | true                   | ask                 | true                | false                    |
| strict   | true                   | auto                | true                | true                     |

Modes deliberately do NOT touch provider `roles` or the Oracle lane. `roles.oraclePlanner` remains the enable/disable source of truth for Oracle participation.

Modes are applied via:
- `agent-composer mode <name>` CLI subcommand (reads+writes the project-scope `composer.config.json` atomically via `configMutation` utilities)
- `composer_config_set({ mode })` MCP tool (preset merged first; explicit `codexLifecycle`/`codexReview` fields on the same call override the preset)

Modes are NOT stored in config as a field. Each invocation expands to the concrete patch fields, so the config remains a plain data object with no mode indirection at read time.

### Oracle config block

The parallel change (feat/modes-oracle-config-profiles) adds `oracle.defaultMode` and `oracle.requireExplicitTag` behavior flags, plus a `codexProfiles` map for named Codex invocation profiles. These are owned by `src/config/schema.ts` and `src/tools/oracle.ts` (that parallel change). This ADR notes their existence for completeness but does not specify their schema.

## Consequences

Positive:
- One command to shift posture (`agent-composer mode strict`) replaces multiple hand-edit operations.
- `composer_config_set({ mode })` allows the orchestrator to shift gates programmatically during a session.
- Explicit field overrides on the same `config_set` call win over the preset, preserving fine-grained control.
- No new schema field added for `mode` itself — the config stays clean.

Negative:
- The applied mode is not recoverable from config alone (no stored mode name). A `doctor` command cannot report "currently in strict mode".
- Modes do not cover all config knobs; operators with unusual setups must still hand-edit.
