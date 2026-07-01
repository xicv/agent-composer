---
name: composer-profile
description: Use when the user says /composer-profile, switch composer profile, load executor profile, activate executor profile, list composer profiles, or which provider profile is active.
---

# Composer Executor Profile

Use this skill to inspect or switch Composer executor profiles. Executor
profiles select the provider templates for research/code/review roles. They do
not select the orchestrating brain: Codex stays the brain.

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
  "activeProfile": "<name>"
}
```

To revert to the default profile, call `composer_config_set` with
`{ "scope": "project", "clearActiveProfile": true }`.

Use `scope: "global"` only when the user explicitly asks for the global
Composer config. Let the server validate the profile name and config shape.

After switching, call `composer_status` again and confirm
`executorProfile.active` and `executorProfile.source`.

## Where Profiles Live

Profiles must be defined in the config the server actually loads: the project
`composer.config.json`, or the user-global
`~/.config/composer/composer.config.json` when the server's `COMPOSER_CONFIG`
env points there. A profile defined in a config the server does not read will
not appear in `composer_status` -> `executorProfile.available`.

A profile with no active selection is inert: zero behavior change, only a
documented shape. Selecting one is `composer_config_set { scope,
activeProfile }`; reverting is `{ scope, clearActiveProfile: true }`. Adding or
editing a profile definition is a config-file edit.

Runtime fallbacks fire only for read-only roles: researcher, reviewer,
reviewerClaude, and oraclePlanner. Mutating roles, coder and coderCli, are
single-attempt by design (Slice 4 deferred), so a `fallbacks` chain whose source
is a mutating role is validated at config load but never fires at runtime. The
shipped `glm-coder` sample therefore uses the read-only
`reviewerClaude -> reviewer` chain.

## Notes

- Profiles are executor-only: researcher, coder, reviewer, reviewerClaude,
  coderCli, and oraclePlanner provider assignments.
- Profile role overrides are atomic replacements. Do not deep-merge role
  configs by hand.
- Brain selection is reserved for a future Composer field per ADR 0009.
