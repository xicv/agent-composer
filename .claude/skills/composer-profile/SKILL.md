---
name: composer-profile
description: Use when the user says /composer-profile, switch composer profile, load executor profile, activate executor profile, list composer profiles, or which provider profile is active.
---

# Composer Executor Profile

Use this skill to inspect or switch Composer executor profiles. Executor
profiles select the provider templates for research/code/review roles. They do
not select the orchestrating brain: Claude stays the brain.

Do not confuse this with `composer_session_set`'s `profile`, which is the
Codex `code_cli` model/effort lane. Do not confuse it with `modes`, which tune
review and lifecycle gates.

## List / Show

Prefer the live MCP status tool:

```text
composer_status
```

Read `executorProfile.active`, `executorProfile.source`,
`executorProfile.available`, and `executorProfile.warnings`.

If status is unavailable, read raw config with:

```text
composer_config_get
```

Report the active profile, the selection source, the available profile names,
and any warnings. Do not infer activation from a profile merely existing under
`profiles`.

## Switch Durably

Before writing, call `composer_status`.

If `executorProfile.source` is `"env"`, stop. Tell the user
`COMPOSER_PROFILE` is authoritative and wins over `activeProfile`; a
`composer_config_set` write will appear ineffective until the environment
override is unset or changed.

If the source is not `"env"`, switch with a narrow config patch:

```json
{
  "scope": "project",
  "patch": {
    "activeProfile": "<name>"
  }
}
```

Use `scope: "global"` only when the user explicitly asks for the global
Composer config. Let the server validate the profile name and config shape.

After switching, call `composer_status` again and confirm
`executorProfile.active` and `executorProfile.source`.

## Notes

- Profiles are executor-only: researcher, coder, reviewer, reviewerClaude,
  coderCli, and oraclePlanner provider assignments.
- Profile role overrides are atomic replacements. Do not deep-merge role
  configs by hand.
- Brain selection is reserved for a future Composer field per ADR 0009.
