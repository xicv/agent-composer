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

DISPATCH_GUARD_DEFAULT_TIMEOUT_MS=5000
DISPATCH_GUARD_MAX_TIMEOUT_MS=30000
DISPATCH_GUARD_DEFAULT_MAX_CONCURRENCY=4
LOG="${COMPOSER_DISPATCH_LOG:-/tmp/composer-dispatch-log.jsonl}"
DISPATCH_SLOT_DIR="${TMPDIR:-/tmp}/composer-dispatch-guard-slots"
DISPATCH_SLOT=""
DISPATCH_INPUT_FILE=""

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

resolve_dispatch_timeout_ms() {
  local configured="${COMPOSER_DISPATCH_GUARD_TIMEOUT_MS:-$DISPATCH_GUARD_DEFAULT_TIMEOUT_MS}"
  case "$configured" in
    ''|*[!0-9]*) configured="$DISPATCH_GUARD_DEFAULT_TIMEOUT_MS" ;;
  esac
  if [[ "$configured" -lt 1 ]]; then
    configured="$DISPATCH_GUARD_DEFAULT_TIMEOUT_MS"
  elif [[ "$configured" -gt "$DISPATCH_GUARD_MAX_TIMEOUT_MS" ]]; then
    configured="$DISPATCH_GUARD_MAX_TIMEOUT_MS"
  fi
  printf '%s\n' "$configured"
}

timeout_ms_to_seconds() {
  local timeout_ms="$1"
  local seconds=$(( (timeout_ms + 999) / 1000 ))
  [[ "$seconds" -gt 0 ]] || seconds=1
  printf '%s\n' "$seconds"
}

resolve_dispatch_max_concurrency() {
  local configured="${COMPOSER_DISPATCH_GUARD_MAX_CONCURRENCY:-$DISPATCH_GUARD_DEFAULT_MAX_CONCURRENCY}"
  case "$configured" in
    ''|*[!0-9]*) configured="$DISPATCH_GUARD_DEFAULT_MAX_CONCURRENCY" ;;
  esac
  if [[ "$configured" -lt 1 ]]; then
    configured=1
  elif [[ "$configured" -gt 32 ]]; then
    configured=32
  fi
  printf '%s\n' "$configured"
}

log_dispatch_reason() {
  local reason_code="$1"
  local stage="$2"
  local elapsed_ms="${3:-0}"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg reason_code "$reason_code" \
    --arg stage "$stage" \
    --argjson elapsed_wall_ms "$elapsed_ms" \
    '{ts:$ts,kind:"guard_event",reason_code:$reason_code,stage:$stage,elapsed_wall_ms:$elapsed_wall_ms}' \
    >> "$LOG" 2>/dev/null \
    || printf '{"ts":"%s","kind":"guard_event","reason_code":"%s","stage":"%s","elapsed_wall_ms":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$reason_code" "$stage" "$elapsed_ms" >> "$LOG" 2>/dev/null || true
}

cleanup_dispatch_slots() {
  local timeout_ms="$1"
  local max_age_seconds=$(( (timeout_ms + 999) / 1000 + 10 ))
  local slot pid started now age
  mkdir -p "$DISPATCH_SLOT_DIR" 2>/dev/null || return 0
  now="$(date +%s)"
  for slot in "$DISPATCH_SLOT_DIR"/*.lock; do
    [[ -d "$slot" ]] || continue
    pid="$(cat "$slot/pid" 2>/dev/null || true)"
    started="$(cat "$slot/started" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) pid="" ;; esac
    case "$started" in ''|*[!0-9]*) started=0 ;; esac
    age=$(( now - started ))
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null || [[ "$age" -gt "$max_age_seconds" ]]; then
      rm -rf "$slot" 2>/dev/null || true
    fi
  done
}

acquire_dispatch_slot() {
  local timeout_ms="$1"
  local max_slots i slot
  max_slots="$(resolve_dispatch_max_concurrency)"
  cleanup_dispatch_slots "$timeout_ms"
  i=1
  while [[ "$i" -le "$max_slots" ]]; do
    slot="$DISPATCH_SLOT_DIR/$i.lock"
    if mkdir "$slot" 2>/dev/null; then
      printf '%s\n' "$$" > "$slot/pid" 2>/dev/null || true
      date +%s > "$slot/started" 2>/dev/null || true
      DISPATCH_SLOT="$slot"
      return 0
    fi
    i=$((i + 1))
  done
  log_dispatch_reason "dispatch_concurrency_limit" "dispatch_hint" 0
  return 1
}

release_dispatch_slot() {
  [[ -n "$DISPATCH_SLOT" ]] || return 0
  rm -rf "$DISPATCH_SLOT" 2>/dev/null || true
  DISPATCH_SLOT=""
}

cleanup_dispatch_guard() {
  release_dispatch_slot
  [[ -n "$DISPATCH_INPUT_FILE" ]] && rm -f "$DISPATCH_INPUT_FILE" 2>/dev/null || true
}

kill_tree() {
  local sig="$1" root="$2" child
  kill -STOP "$root" 2>/dev/null || true
  for child in $(pgrep -P "$root" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  kill -"$sig" "$root" 2>/dev/null || true
  kill -CONT "$root" 2>/dev/null || true
}

teardown_spawn() {
  local sig="$1" pid="$2" pgid_mode="$3"
  if [[ "$pgid_mode" == "1" ]] && kill -"$sig" "-$pid" 2>/dev/null; then
    return 0
  fi
  kill_tree "$sig" "$pid"
}

register_reaper_watchdog() {
  local pid="$1"
  local max_age_seconds="$2"
  local reaper="${COMPOSER_CUA_REAPER:-}"
  if [[ -z "$reaper" && -n "${PROJECT_DIR:-}" ]]; then
    reaper="$PROJECT_DIR/scripts/codex-cua-reaper.sh"
  fi
  [[ -x "$reaper" ]] || return 0
  "$reaper" --register "$pid" "dispatch_hint" "$max_age_seconds" >/dev/null 2>&1 || true
}

run_bounded_capture() {
  local timeout_seconds="$1"
  shift
  local pid watchdog status marker pgid_mode out_file
  out_file="$(mktemp -t composer_dispatch_hint_out.XXXXXX)" || return 1
  marker="${TMPDIR:-/tmp}/composer-dispatch-timeout.$$.$RANDOM"
  pgid_mode=0
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" < "$DISPATCH_INPUT_FILE" > "$out_file" 2>/dev/null &
    pid=$!
    pgid_mode=1
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'setpgrp(0,0); exec @ARGV or die "exec failed: $!"' "$@" < "$DISPATCH_INPUT_FILE" > "$out_file" 2>/dev/null &
    pid=$!
    pgid_mode=1
  else
    "$@" < "$DISPATCH_INPUT_FILE" > "$out_file" 2>/dev/null &
    pid=$!
  fi
  register_reaper_watchdog "$pid" "$timeout_seconds"
  (
    sleeper=""
    trap '[[ -n "$sleeper" ]] && kill "$sleeper" 2>/dev/null || true; exit 0' TERM INT
    sleep "$timeout_seconds" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null || exit 0
    printf '1' >"$marker" 2>/dev/null || true
    teardown_spawn TERM "$pid" "$pgid_mode"
    sleep 1
    teardown_spawn KILL "$pid" "$pgid_mode"
  ) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  cat "$out_file" 2>/dev/null || true
  rm -f "$out_file" 2>/dev/null || true
  if [[ -f "$marker" ]]; then
    rm -f "$marker" 2>/dev/null || true
    return 124
  fi
  rm -f "$marker" 2>/dev/null || true
  return "$status"
}

run_hint_attempt() {
  local timeout_seconds="$1"
  shift
  local start end output status
  start="$(date +%s)"
  output="$(run_bounded_capture "$timeout_seconds" "$@")"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    printf '%s' "$output"
    return 0
  fi
  end="$(date +%s)"
  if [[ "$status" -eq 124 ]]; then
    log_dispatch_reason "dispatch_timeout" "dispatch_hint" "$(( (end - start) * 1000 ))"
  fi
  return "$status"
}

remaining_hint_seconds() {
  local started="$1"
  local total="$2"
  local now elapsed remaining
  now="$(date +%s)"
  elapsed=$(( now - started ))
  remaining=$(( total - elapsed ))
  if [[ "$remaining" -le 0 ]]; then
    printf '0\n'
  else
    printf '%s\n' "$remaining"
  fi
}

if command -v timeout >/dev/null 2>&1; then
  INPUT="$(timeout 5 cat 2>/dev/null || true)"
else
  INPUT="$(cat || true)"
fi
[[ -z "$INPUT" ]] && exit 0
trap cleanup_dispatch_guard EXIT

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
NORMALIZED_PAYLOAD="$(
  { printf '%s\n' "$DESCRIPTION"; printf '%s' "$PROMPT"; } \
    | tr '[:upper:]' '[:lower:]' \
    | tr '\n\r\t' '   ' \
    | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
)"

HAS_FILE_REF="false"
if printf '%s' "$PROMPT" | grep -qE '(\.[a-z]{1,4}|src/|tests/|lib/|app/)[A-Za-z0-9._/-]*(:[0-9]+)?' 2>/dev/null; then
  HAS_FILE_REF="true"
fi

HAS_DESTRUCTIVE="false"
if printf '%s' "$NORMALIZED_PAYLOAD" | grep -qE '\b(rm -rf|drop table|delete from|destroy|reset --hard|--force)\b' 2>/dev/null; then
  HAS_DESTRUCTIVE="true"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EPOCH_SECOND="$(date +%s)"
DEDUP_SENTINEL="/tmp/composer-dispatch-guard-last"
DEDUP_HASH="$(
  { printf '%s\n' "$DESCRIPTION"; printf '%s' "$PROMPT"; } \
    | shasum -a 256 2>/dev/null \
    | awk '{print $1}' 2>/dev/null
)"
if [[ -z "$DEDUP_HASH" ]]; then
  DEDUP_HASH="$(
    { printf '%s\n' "$DESCRIPTION"; printf '%s' "$PROMPT"; } \
      | cksum 2>/dev/null \
      | awk '{print $1":"$2}' 2>/dev/null
  )"
fi
DEDUP_KEY="${DEDUP_HASH}:${EPOCH_SECOND}"
LAST_DEDUP_KEY="$(cat "$DEDUP_SENTINEL" 2>/dev/null || true)"
SKIP_LOG="false"
if [[ -n "$DEDUP_HASH" && "$DEDUP_KEY" == "$LAST_DEDUP_KEY" ]]; then
  SKIP_LOG="true"
elif [[ -n "$DEDUP_HASH" ]]; then
  printf '%s' "$DEDUP_KEY" > "$DEDUP_SENTINEL" 2>/dev/null || true
fi

# Phase 1: always log. Phase 2 (below) may then deny.
if [[ "$SKIP_LOG" != "true" ]]; then
  jq -nc \
    --arg ts "$TS" \
    --arg subagent "$SUBAGENT" \
    --arg description "$DESCRIPTION" \
    --argjson prompt_len "$PROMPT_LEN" \
    --argjson has_file_ref "$HAS_FILE_REF" \
    --argjson has_destructive "$HAS_DESTRUCTIVE" \
    '{ts:$ts, subagent_type:$subagent, description:$description, prompt_len:$prompt_len, has_file_ref:$has_file_ref, has_destructive:$has_destructive}' \
    >> "$LOG" 2>/dev/null || true
fi

# Phase 2 hint: best-effort deterministic sizing/routing signal. This is
# advisory only; failure to compute or parse it must not affect permission.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$PROJECT_DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
fi

HINT_JSON=""
DISPATCH_TIMEOUT_MS="$(resolve_dispatch_timeout_ms)"
DISPATCH_TIMEOUT_SECONDS="$(timeout_ms_to_seconds "$DISPATCH_TIMEOUT_MS")"
if [[ -n "$PROJECT_DIR" ]]; then
  DISPATCH_INPUT_FILE="$(mktemp -t composer_dispatch_input.XXXXXX)" || DISPATCH_INPUT_FILE=""
  [[ -n "$DISPATCH_INPUT_FILE" ]] && printf '%s' "$INPUT" > "$DISPATCH_INPUT_FILE" 2>/dev/null || true
fi
if [[ -n "$DISPATCH_INPUT_FILE" ]] && acquire_dispatch_slot "$DISPATCH_TIMEOUT_MS"; then
  DISPATCH_HINT_STARTED="$(date +%s)"
  if [[ -n "$PROJECT_DIR" && -x "$PROJECT_DIR/node_modules/.bin/tsx" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]]; then
    REMAINING_SECONDS="$(remaining_hint_seconds "$DISPATCH_HINT_STARTED" "$DISPATCH_TIMEOUT_SECONDS")"
    if [[ "$REMAINING_SECONDS" -gt 0 ]]; then
      HINT_JSON="$(run_hint_attempt "$REMAINING_SECONDS" bash -c 'cd "$1" && exec "$2" "$3"' _ "$PROJECT_DIR" "$PROJECT_DIR/node_modules/.bin/tsx" "$PROJECT_DIR/src/cli/dispatch-hint.ts" || true)"
    fi
  fi
  if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]] && command -v npx >/dev/null 2>&1; then
    REMAINING_SECONDS="$(remaining_hint_seconds "$DISPATCH_HINT_STARTED" "$DISPATCH_TIMEOUT_SECONDS")"
    if [[ "$REMAINING_SECONDS" -gt 0 ]]; then
      HINT_JSON="$(run_hint_attempt "$REMAINING_SECONDS" bash -c 'cd "$1" && exec npx --no-install --package tsx tsx "$2"' _ "$PROJECT_DIR" "$PROJECT_DIR/src/cli/dispatch-hint.ts" || true)"
    fi
  fi
  if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/src/cli/dispatch-hint.ts" ]] && command -v node >/dev/null 2>&1; then
    REMAINING_SECONDS="$(remaining_hint_seconds "$DISPATCH_HINT_STARTED" "$DISPATCH_TIMEOUT_SECONDS")"
    if [[ "$REMAINING_SECONDS" -gt 0 ]]; then
      HINT_JSON="$(run_hint_attempt "$REMAINING_SECONDS" bash -c 'cd "$1" && exec node --import tsx "$2"' _ "$PROJECT_DIR" "$PROJECT_DIR/src/cli/dispatch-hint.ts" || true)"
    fi
  fi
  if [[ -z "$HINT_JSON" && -n "$PROJECT_DIR" && -f "$PROJECT_DIR/dist/cli/dispatch-hint.js" ]]; then
    REMAINING_SECONDS="$(remaining_hint_seconds "$DISPATCH_HINT_STARTED" "$DISPATCH_TIMEOUT_SECONDS")"
    if [[ "$REMAINING_SECONDS" -gt 0 ]]; then
      HINT_JSON="$(run_hint_attempt "$REMAINING_SECONDS" node "$PROJECT_DIR/dist/cli/dispatch-hint.js" || true)"
    fi
  fi
fi

HINT_VALID="false"
if [[ -n "$HINT_JSON" ]] && jq -e . >/dev/null 2>&1 <<<"$HINT_JSON"; then
  HINT_VALID="true"
  if [[ "$SKIP_LOG" != "true" ]]; then
    jq -nc \
      --arg ts "$TS" \
      --arg subagent "$SUBAGENT" \
      --argjson hint "$HINT_JSON" \
      '{ts:$ts, kind:"hint", subagent_type:$subagent, hint:$hint}' \
      >> "$LOG" 2>/dev/null || true
  fi
fi

# Phase 2 deny rule: destructive-op refusals must NOT be dispatched.
# SKILL frontmatter already declares this inline; hook is the backstop
# when the orchestrator's pre-load reasoning drifts. Narrow scope: only
# fires when prompt clearly contains a destructive verb AND the worker
# is one of composer's roles.
case "$SUBAGENT" in
  coder|researcher|reviewer)
    if [[ "$HAS_DESTRUCTIVE" == "true" ]]; then
      emit_deny "dispatch_guard: destructive-op pattern detected; refuse inline (SKILL frontmatter SKIP-condition b). Subagent=${SUBAGENT}, len=${PROMPT_LEN}."
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
