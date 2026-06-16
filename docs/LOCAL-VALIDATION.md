# Local validation for Oracle/Composer safe adapter

## 1. Check which Oracle is actually on PATH

```bash
type -a oracle
command -v oracle
oracle --version
oracle --debug-help | sed -n '/Browser Options/,$p' | head -80
```

Important: many browser flags in Oracle 0.13.0 are hidden from normal `oracle --help`. Use `oracle --debug-help` or a dry-run parse smoke instead.

## 2. Parse-smoke the hidden browser flags without launching Chrome

```bash
oracle --engine browser --dry-run summary \
  --browser-manual-login \
  --browser-timeout 2s \
  --browser-input-timeout 2s \
  --browser-auto-reattach-delay 1s \
  --browser-auto-reattach-interval 0 \
  --browser-auto-reattach-timeout 1s \
  --browser-thinking-time light \
  --browser-model-strategy current \
  -m gpt-5.5-pro \
  -p "flag parse smoke"
```

If this says `unknown option`, either the installed binary is not the official `@steipete/oracle@0.13.0`, a wrapper is shadowing it, or your package manager installed a different build.

## 3. Adapter dry run

```bash
scripts/oracle-pro-safe.sh --dry-run --mode quick -- "Smoke test. Say OK."
```

The adapter probes optional flags and skips unsupported ones. It should not die merely because a hidden/optional flag is absent.

## 4. Real browser run

```bash
scripts/oracle-pro-safe.sh --mode quick -- "Say OK and identify the model/mode you received."
```

For first-time login, Oracle's manual profile may open Chrome. Complete the login once, then rerun.

## 5. Composer integration (first-class oraclePlanner role)

Oracle is an opt-in `oraclePlanner` role — do NOT repoint `researcher` (it stays
on Codex; see ADR 0005). Add the role to your active config:

```json
"oraclePlanner": {
  "provider": "cli",
  "cli": ["bash", "scripts/oracle-plan-mcp.sh", "--mode", "auto", "--"],
  "timeoutMs": 1200000,
  "retries": 0,
  "maxResultChars": 14000
}
```

Then call it explicitly:
- `composer_oracle_plan` (sync) for planning/review/debug on the critical path
- `composer_oracle_job_start` + `composer_oracle_job_result` (async) for long
  research or when you don't want to block

The `composer-oracle-router-safe.sh` script (default route = Codex, Oracle only
on an explicit `[oracle:*]` tag) is provided for experimentation but is NOT the
recommended wiring; prefer the first-class role above.
