# Composer main follow-up — model-version migration report (2026-06-14)

## Summary

Research-first follow-up on latest main. Kept the library GLM fallback stable at `glm-5.1`, pinned this project's coder role and new `agent-composer init` scaffolds to verified `glm-5.2` (requires a z.ai Coding Plan token), and moved the Codex review gate to `gpt-5.5`. Two errors in a prior Oracle handoff were corrected.

## Research findings (web-verified 2026-06-14)

- GLM-5.2 shipped 2026-06-13 (Zhipu/z.ai). Exact ID `glm-5.2` (1M context, 131K max output). Reachable today only via the z.ai GLM Coding Plan endpoint (https://api.z.ai/api/anthropic); standalone metered API + open weights ship ~week of 2026-06-15.
- Correction: the valid GLM API model code is plain `glm-5.2`. An initial attempt used `glm-5.2[1m]`, but a direct provider probe against `api.z.ai/api/anthropic` returned error 1211 `Unknown Model` for `glm-5.2[1m]` while `glm-5.2` succeeded. Controls `glm-4.6` and `glm-5.1` also resolved. `[1m]` is a Claude-Code display alias, not a valid z.ai API model code.
- `gpt-5.5-pro` is NOT an OpenAI Codex API surface model. It exists as a ChatGPT-Pro browser model (Oracle deep lane) and in the general API. The correct Codex review-gate upgrade is `gpt-5.5` (Codex frontier).
- `gpt-5.4-mini` remains the documented cheap model for lightweight/subagent tasks — kept on codexRescue + codexLifecycle.
- Orchestrator brain: claude-opus-4-8. MCP SDK: @modelcontextprotocol/sdk ^1.29.0 (current).

## Changes applied

| File | Edit site | Change |
|---|---|---|
| `src/registry.ts` | `DEFAULT_ANTHROPIC_MODEL` | Kept library fallback at `glm-5.1` |
| `src/config/env.ts` | doc comment | Documents fallback as `glm-5.1` |
| `scripts/run-evolve.ts` | fallback | Kept fallback at `glm-5.1` |
| `composer.config.json` | `roles.coder.model` | Explicit project pin to verified `glm-5.2` |
| `src/cli/init.ts` | `DEFAULT_COMPOSER_CONFIG.roles.coder.model` | New `agent-composer init` projects scaffold `glm-5.2`; `DEFAULT_ANTHROPIC_MODEL` remains `glm-5.1` for consumers without Coding-Plan access |
| `composer.config.json` | `roles.researcher.cli` | Added explicit `gpt-5.4-mini` Codex model pin |
| `composer.config.json` | `roles.coderCli.cli` | Left profile-driven; no static model pin |
| `composer.config.json` | `codexReview.model` | `gpt-5.4-mini` -> `gpt-5.5` |
| `composer.config.schema.json` | description | `glm-5.1` -> `glm-5.2` |
| `tests/registry.test.ts` | default test title + assertion | Expected library fallback remains `glm-5.1` |
| `src/cli/init.ts` | `researcher`, `coder`, `coderCli`, `codexReview` defaults | Researcher pinned to `gpt-5.4-mini`; coder scaffold pins `glm-5.2`; coderCli remains profile-driven; codexReview updated to `gpt-5.5` |
| `tests/cli/init.test.ts` | assertions | Updated researcher pin, coderCli profile-driven args, and codexReview model |
| `tests/config/loader.test.ts` | researcher CLI assertion | Updated expected Codex model pin |
| `README.md` | `codexReview` example | Updated to `gpt-5.5` |
| `docs/STATUS.md` | Build 7 dogfood row | Updated model-migration status |
| `docs/reports/composer-main-followup-report.md` | report text | Updated follow-up manifest, correction, verification, and open items |

## Verification

- tsc src EXIT 0.
- tsc test EXIT 0.
- vitest `tests/registry.test.ts` + `tests/cli/init.test.ts` 35/35 pass.
- ajv schema validate `composer.config.json` valid.
- zero active `glm-5.2[1m]` model references remain outside this correction report.
- `DEFAULT_ANTHROPIC_MODEL` remains `glm-5.1`.
- New `agent-composer init` projects scaffold `roles.coder.model=glm-5.2`, which requires a z.ai Coding Plan token; the library fallback remains `glm-5.1` for consumers without Coding-Plan access.
- Live provider probe confirmed the explicit `roles.coder.model=glm-5.2` project pin resolves on the z.ai Coding Plan endpoint.
- Researcher is pinned to `gpt-5.4-mini`; coderCli has no static model pin and uses profile-driven model selection; codexReview is `gpt-5.5`.

## Open items

- DONE: Live verification that the z.ai Coding Plan endpoint serves `glm-5.2` with the active token.
- DONE: Oracle P1 #2 adjusted: researcher is pinned to `gpt-5.4-mini`; coderCli is profile-driven with no static model pin.
- Deferred by decision: SVG project icon (no consumer yet), unbounded-evolve unsafe flag (kept `maxCalls:100`).

## Review request

Please prioritize model-ID correctness, the codexReview-only upgrade scope, any missed call sites, and whether the `glm-5.2` vs `glm-5.2` (non-1M) choice is right for repo-scale agentic coding.
