# Composer Oracle integration handoff

## Problem

The initial adapter hardcoded Oracle flags. That is brittle because Oracle has hidden options, fast-moving browser options, and possible local package-manager skew. The fixed integration must probe the local `oracle` binary and include only supported flags.

## Correct dispatch model

Use model choice as the primary cost/speed selector:

- quick: `ORACLE_PRO_QUICK_MODEL`, default `gpt-5.2-instant`
- standard: `ORACLE_PRO_STANDARD_MODEL`, default `gpt-5.5`
- deep/plan/review/debug: `ORACLE_PRO_DEEP_MODEL`, default `gpt-5.5-pro`
- research: deep model plus `--browser-research deep` when supported

If the local Oracle binary accepts `--browser-thinking-time`, pass it as an additive browser UI selector:

- quick: `light`
- standard: `standard`
- deep/review/debug/research: `extended` by default, configurable to `heavy`

If the binary rejects that flag, skip it. Do not fail the run.

## Phase 1: config-only Composer integration

Use the fixed existing role `researcher`, because current Composer schema has fixed roles and `additionalProperties:false`.

```json
{
  "roles": {
    "researcher": {
      "provider": "cli",
      "cli": ["bash", "scripts/composer-oracle-router-safe.sh"],
      "timeoutMs": 1200000,
      "retries": 0,
      "maxResultChars": 14000
    }
  }
}
```

## Phase 2: first-class Composer feature

Add a new role and MCP tool:

- schema role: `oraclePlanner`
- tool: `composer_oracle_plan`
- output: `.composer/oracle/answers/<id>.md`
- handoff output: `.composer/handoffs/<id>.md`
- result output: `.composer/results/<id>.md`

The tool should call `scripts/oracle-pro-safe.sh`, not raw `oracle`, so it inherits feature probing and local overrides.

## Security constraints

- Never read arbitrary files by default.
- Never include `.env`, keys, certs, cookies, or browser profiles.
- Use compact git status/stat/diff context.
- Keep Codex execution opt-in.
- Keep browser Deep Research explicit.
