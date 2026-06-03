#!/usr/bin/env bash
# Composer dispatch_guard — PreToolUse hook for Task/Agent dispatches.
#
# Two-phase design:
#   Phase 1 (observability): log every Task dispatch to
#     /tmp/composer-dispatch-log.jsonl with structured fields. Never
#     denies. Inspect the log to derive empirical thresholds.
#   Phase 2 (enforcement): deny dispatches that the SKILL frontmatter
#     SKIP-conditions already declared inline — destructive-op refusals
#     dispatched to a worker. Defense in depth: SKILL's pre-load
#     reasoning may drift, hook is a deterministic backstop.
#
# Contract:
#   stdin:  Anthropic PreToolUse JSON ({tool_name, tool_input, ...})
#   stdout: optional permission JSON (allow by default)
#   exit:   always 0
#
# Wire via .claude/settings.local.json (see settings.local.json.example).

set -u

composer_disabled() {
  case "${COMPOSER_ENABLED:-}" in
    0|false|FALSE|off|OFF|no|NO) return 0 ;;
  esac
  case "${COMPOSER_DISABLED:-}" in
    1|true|TRUE|on|ON|yes|YES) return 0 ;;
  esac
  if [[ -n "${COMPOSER_DISABLED_FILE:-}" && -e "$COMPOSER_DISABLED_FILE" ]]; then
    return 0
  fi
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -e "$CLAUDE_PROJECT_DIR/.composer-disabled" ]]; then
    return 0
  fi
  if [[ -n "${HOME:-}" && -e "$HOME/.claude/composer.disabled" ]]; then
    return 0
  fi
  return 1
}

if composer_disabled; then
  exit 0
fi

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

emit_hint() {
  local hint="$1"
  jq -nc --arg h "$hint" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$h}}' 2>/dev/null \
    || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$hint"
  exit 0
}

INPUT="$(cat || true)"
[[ -z "$INPUT" ]] && exit 0

# Hard dependency on jq for safe JSON parsing. Fail-open with a stderr
# breadcrumb if it is missing — phase-1 observability is best-effort.
if ! command -v jq >/dev/null 2>&1; then
  echo "dispatch_guard: jq missing, skipping" >&2
  exit 0
fi

TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)"
[[ "$TOOL" != "Task" && "$TOOL" != "Agent" ]] && exit 0

SUBAGENT="$(jq -r '.tool_input.subagent_type // empty' <<<"$INPUT" 2>/dev/null)"
PROMPT="$(jq -r '.tool_input.prompt // empty' <<<"$INPUT" 2>/dev/null)"
DESCRIPTION="$(jq -r '.tool_input.description // empty' <<<"$INPUT" 2>/dev/null)"
PROMPT_LEN="${#PROMPT}"

HAS_FILE_REF="false"
if printf '%s' "$PROMPT" | grep -qE '(\.[a-z]{1,4}|src/|tests/|lib/|app/)[A-Za-z0-9._/-]*(:[0-9]+)?' 2>/dev/null; then
  HAS_FILE_REF="true"
fi

HAS_DESTRUCTIVE="false"
if printf '%s' "$PROMPT" | grep -qiE '\b(rm -rf|drop table|delete from|destroy|reset --hard|--force)\b' 2>/dev/null; then
  HAS_DESTRUCTIVE="true"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="/tmp/composer-dispatch-log.jsonl"

# Phase 1: always log. Phase 2 (below) may then deny.
jq -nc \
  --arg ts "$TS" \
  --arg subagent "$SUBAGENT" \
  --arg description "$DESCRIPTION" \
  --argjson prompt_len "$PROMPT_LEN" \
  --argjson has_file_ref "$HAS_FILE_REF" \
  --argjson has_destructive "$HAS_DESTRUCTIVE" \
  '{ts:$ts, subagent_type:$subagent, description:$description, prompt_len:$prompt_len, has_file_ref:$has_file_ref, has_destructive:$has_destructive}' \
  >> "$LOG" 2>/dev/null || true

# Phase 2 hint: best-effort deterministic sizing/routing signal. This is
# advisory only; failure to compute or parse it must not affect permission.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$PROJECT_DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
fi

HINT_JSON=""
if [[ -n "$PROJECT_DIR" && -x "$PROJECT_DIR/node_modules/.bin/tsx" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]]; then
  HINT_JSON="$(printf '%s' "$INPUT" | (cd "$PROJECT_DIR" 2>/dev/null && "$PROJECT_DIR/node_modules/.bin/tsx" "$PROJECT_DIR/src/cli/dispatch-hint.ts") 2>/dev/null || true)"
fi
if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]] && command -v npx >/dev/null 2>&1; then
  HINT_JSON="$(printf '%s' "$INPUT" | (cd "$PROJECT_DIR" 2>/dev/null && npx --no-install --package tsx tsx "$PROJECT_DIR/src/cli/dispatch-hint.ts") 2>/dev/null || true)"
fi
if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]] && command -v node >/dev/null 2>&1; then
  HINT_JSON="$(printf '%s' "$INPUT" | (cd "$PROJECT_DIR" 2>/dev/null && node --import tsx "$PROJECT_DIR/src/cli/dispatch-hint.ts") 2>/dev/null || true)"
fi
if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/dist/cli/dispatch-hint.js" ]]; then
  HINT_JSON="$(printf '%s' "$INPUT" | node "$PROJECT_DIR/dist/cli/dispatch-hint.js" 2>/dev/null || true)"
fi

HINT_VALID="false"
if [[ -n "$HINT_JSON" ]] && jq -e . >/dev/null 2>&1 <<<"$HINT_JSON"; then
  HINT_VALID="true"
  jq -nc \
    --arg ts "$TS" \
    --arg subagent "$SUBAGENT" \
    --argjson hint "$HINT_JSON" \
    '{ts:$ts, kind:"hint", subagent_type:$subagent, hint:$hint}' \
    >> "$LOG" 2>/dev/null || true
fi

# Phase 2 deny rule: destructive-op refusals must NOT be dispatched.
# SKILL frontmatter already declares this inline; hook is the backstop
# when the orchestrator's pre-load reasoning drifts. Narrow scope: only
# fires when prompt clearly contains a destructive verb AND the worker
# is one of composer's roles.
case "$SUBAGENT" in
  coder|researcher|reviewer)
    if [[ "$HAS_DESTRUCTIVE" == "true" && "$PROMPT_LEN" -lt 200 ]]; then
      emit_deny "dispatch_guard: destructive-op pattern detected in tiny prompt; refuse inline (SKILL frontmatter SKIP-condition b). Subagent=${SUBAGENT}, len=${PROMPT_LEN}."
    fi
    ;;
esac

# Default: allow, with a compact deterministic hint for the orchestrator.
if [[ "$HINT_VALID" == "true" ]]; then
  HINT_TEXT="$(
    jq -er '
      select((.tier | type == "string") and
        (.promptSize | type == "string") and
        (.reasoning | type == "string") and
        (.route.target | type == "string") and
        (.route.taskClass | type == "string") and
        (.recommendDispatch | type == "boolean"))
      | "dispatch-hint: route=\(.route.target) class=\(.route.taskClass) tier=\(.tier) size=\(.promptSize) reasoning=\(.reasoning) recommendDispatch=\(.recommendDispatch)"
    ' <<<"$HINT_JSON" 2>/dev/null || true
  )"
  if [[ -n "$HINT_TEXT" ]]; then
    emit_hint "$HINT_TEXT"
  fi
fi

# Fail-open if the optional TS hint path is unavailable.
exit 0
