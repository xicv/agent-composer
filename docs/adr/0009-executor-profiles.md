# ADR 0009 - Executor Profiles

- **Date**: 2026-06-22
- **Status**: Accepted
- **Companion**: ADR 0006 (modes and oracle config profiles)

## Context

Composer maps executor roles (`researcher`, `coder`, `reviewer`, `reviewerClaude`, `coderCli`, `oraclePlanner`) to provider implementations in `composer.config.json`. Before this change, that role map was fixed per config file. Operators could not switch the whole executor assignment as a named unit, and per-role fallback configuration existed only inside the Codex lifecycle lane.

C0.2 config remains frozen and append-only. Existing `roles` and every existing top-level field keep their current meaning.

## Decision

### Additive config contract

Add two optional top-level fields:
- `profiles`: a map from profile name to executor profile.
- `activeProfile`: the profile name selected by config when no environment override is set.

When both fields are absent, Composer behaves exactly as before. The top-level `roles` object remains the default effective executor config and remains the raw config write target.

### Executor-only profiles

Profiles are executor-only. A profile object may contain only:
- `roles`
- `fallbacks`
- `mode`

Profiles must not carry brain, harness, orchestrator, or provider-of-brain keys. Claude remains the orchestrating brain for this iteration. Brain selection is reserved for a future iteration and a future explicit field.

`mode` selects one existing built-in mode (`fast`, `balanced`, `strict`). It does not redefine mode gates.

### Atomic role replacement

Role overrides are atomic replacement, not deep merge. If a profile names `roles.coder`, that entire role config replaces top-level `roles.coder`.

This avoids stale provider fields when changing provider type. For example, switching a role from Anthropic-compatible GLM to a CLI provider must not preserve old `baseUrl`, `apiKeyEnv`, or model fields unless the profile explicitly supplies them.

### Selection precedence

Profile selection precedence is:
1. `COMPOSER_PROFILE` environment variable
2. top-level `activeProfile`
3. implicit default, meaning raw top-level `roles`

Resolution surfaces both the selected profile name and source (`env`, `config`, or `default`). Invalid environment or config selections fail closed with an error. Composer never silently falls back to the default when a selected profile name is missing.

### Fallback config validation

Profiles may define `fallbacks` as role-to-role chains. This slice validates fallback configuration only:
- source roles and target roles must be valid role names
- every fallback target must resolve to a configured effective role
- self-references are rejected
- duplicate targets are rejected
- cycles across fallback role references are rejected

Runtime fallback execution is deliberately out of scope for this slice. Later work may use the validated config to actually try fallback roles when a provider fails.

## Consequences

Positive:
- Operators can switch executor assignments by name without editing every role.
- Existing configs have zero migration cost.
- Provider-type switches are safer because profile overrides cannot inherit stale fields.
- Invalid profile selection fails early, before provider dispatch.

Negative:
- Fallbacks are only validated in this slice; they do not change runtime dispatch behavior yet.
- Brain selection remains separate future work, so profiles intentionally do not model full-system orchestration.
