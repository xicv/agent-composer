#!/usr/bin/env bash
# Composer dispatch_guard — PreToolUse hook for the Task tool.
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

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
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

# Default: allow.
exit 0
