#!/usr/bin/env bash
# Wave 1 F1.11 — passive learning log (T1 self-evolution tier).
# Runs as a Stop hook. Appends correction-shaped user messages from the
# current session transcript into .claude/learnings/<month>.md.
#
# Fail-safe: any missing dependency, missing transcript, or parse error
# results in a silent no-op (exit 0). This MUST NOT block session-end.

set -u

LEARN_DEFAULT_TIMEOUT_MS=5000
LEARN_MAX_TIMEOUT_MS=30000
LEARN_LOG="${COMPOSER_LEARN_LOG:-/tmp/composer-learn-log.jsonl}"
LEARN_TEMP_FILES=()

cleanup_learn_temp() {
  if ((${#LEARN_TEMP_FILES[@]} > 0)); then
    rm -f "${LEARN_TEMP_FILES[@]}" 2>/dev/null || true
  fi
}

trap cleanup_learn_temp EXIT

_composer_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/composer_disabled.lib.sh"
if [ -r "$_composer_lib" ]; then . "$_composer_lib"; else composer_disabled() { return 1; }; fi

if composer_disabled; then
  exit 0
fi

resolve_learn_timeout_ms() {
  local configured="${COMPOSER_LEARN_HOOK_TIMEOUT_MS:-$LEARN_DEFAULT_TIMEOUT_MS}"
  case "$configured" in
    ''|*[!0-9]*) configured="$LEARN_DEFAULT_TIMEOUT_MS" ;;
  esac
  if [[ "$configured" -lt 1 ]]; then
    configured="$LEARN_DEFAULT_TIMEOUT_MS"
  elif [[ "$configured" -gt "$LEARN_MAX_TIMEOUT_MS" ]]; then
    configured="$LEARN_MAX_TIMEOUT_MS"
  fi
  printf '%s\n' "$configured"
}

timeout_ms_to_seconds() {
  local timeout_ms="$1"
  local seconds=$(( (timeout_ms + 999) / 1000 ))
  [[ "$seconds" -gt 0 ]] || seconds=1
  printf '%s\n' "$seconds"
}

remaining_learn_seconds() {
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

learn_mktemp() {
  local path
  path="$(mktemp -t composer_learnings.XXXXXX)" || return 1
  LEARN_TEMP_FILES+=("$path")
  printf '%s\n' "$path"
}

log_learn_timeout() {
  local elapsed_ms="${1:-0}"
  printf '{"ts":"%s","reason_code":"hook_timeout","stage":"learn_stop","elapsed_wall_ms":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed_ms" >> "$LEARN_LOG" 2>/dev/null || true
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

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  local pid watchdog status marker start end
  marker="${TMPDIR:-/tmp}/composer-learn-timeout.$$.$RANDOM"
  start="$(date +%s)"
  ( "$@" ) &
  pid=$!
  (
    sleeper=""
    trap '[[ -n "$sleeper" ]] && kill "$sleeper" 2>/dev/null || true; exit 0' TERM INT
    sleep "$timeout_seconds" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null || exit 0
    printf '1' >"$marker" 2>/dev/null || true
    kill_tree TERM "$pid"
    sleep 1
    kill_tree KILL "$pid"
  ) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [[ -f "$marker" ]]; then
    rm -f "$marker" 2>/dev/null || true
    end="$(date +%s)"
    log_learn_timeout "$(( (end - start) * 1000 ))"
    return 124
  fi
  rm -f "$marker" 2>/dev/null || true
  return "$status"
}

run_capture_with_timeout() {
  local timeout_seconds="$1"
  local stdin_file="$2"
  shift 2
  local output_file status
  output_file="$(learn_mktemp)" || return 1
  run_with_timeout "$timeout_seconds" bash -c 'exec "$@"' _ "$@" < "$stdin_file" > "$output_file" 2>/dev/null
  status=$?
  cat "$output_file" 2>/dev/null || true
  return "$status"
}

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LEARN_DIR="$PROJECT_DIR/.claude/learnings"
MONTH="$(date +%Y-%m)"
OUT="$LEARN_DIR/${MONTH}.md"

# Read JSON envelope from stdin (Anthropic Stop hook contract).
if command -v timeout >/dev/null 2>&1; then
  INPUT="$(timeout 5 cat 2>/dev/null || true)"
else
  INPUT="$(cat || true)"
fi
if [[ -z "$INPUT" ]]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

LEARN_TIMEOUT_MS="$(resolve_learn_timeout_ms)"
LEARN_TIMEOUT_SECONDS="$(timeout_ms_to_seconds "$LEARN_TIMEOUT_MS")"
LEARN_STARTED="$(date +%s)"
INPUT_FILE="$(learn_mktemp)" || exit 0
printf '%s' "$INPUT" > "$INPUT_FILE" 2>/dev/null || exit 0
REMAINING_SECONDS="$(remaining_learn_seconds "$LEARN_STARTED" "$LEARN_TIMEOUT_SECONDS")"
if [[ "$REMAINING_SECONDS" -le 0 ]]; then
  log_learn_timeout "$LEARN_TIMEOUT_MS"
  exit 0
fi
TRANSCRIPT_PATH="$(run_capture_with_timeout "$REMAINING_SECONDS" "$INPUT_FILE" jq -r '.transcript_path // empty')"
TRANSCRIPT_STATUS=$?
if [[ "$TRANSCRIPT_STATUS" -eq 124 ]]; then
  exit 0
fi
if [[ "$TRANSCRIPT_STATUS" -ne 0 ]]; then
  exit 0
fi
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  exit 0
fi

mkdir -p "$LEARN_DIR" 2>/dev/null || exit 0

# Trigger words for "correction-shaped" user messages.
# Conservative regex; expand from real data over time.
TRIGGER='(?i)\b(no|don.t|do not|wrong|stop|actually|instead|never|please don.t)\b'

process_transcript() {
  local matches="" new_matches=""
  trap 'rm -f "$matches" "$new_matches" 2>/dev/null || true' EXIT TERM INT
  # Anthropic transcripts are JSONL (one event per line). Filter user-role
  # events whose content matches the trigger regex, then append new short
  # bullets only. Truncate to 400 chars to keep the log scannable.
  matches="$(mktemp -t composer_learnings.XXXXXX)" || exit 0
  jq -r --arg trig "$TRIGGER" '
    select(.role == "user" or .type == "user")
    | (.content // .message // "") as $raw
    | (if ($raw | type) == "array" then ($raw | map(.text // "") | join(" ")) else ($raw | tostring) end) as $text
    | select($text | test($trig))
    | "- " + ($text | gsub("\\s+"; " ") | .[0:400])
  ' "$TRANSCRIPT_PATH" 2>/dev/null > "$matches" || exit 0

  new_matches="$(mktemp -t composer_learnings_new.XXXXXX)" || exit 0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ ! -f "$OUT" ]] || ! grep -Fxq -- "$line" "$OUT" 2>/dev/null; then
      printf '%s\n' "$line" >> "$new_matches"
    fi
  done < "$matches"

  if [[ -s "$new_matches" ]]; then
    {
      printf '\n## Session ended %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      cat "$new_matches"
    } >> "$OUT" 2>/dev/null || true
  fi
}

REMAINING_SECONDS="$(remaining_learn_seconds "$LEARN_STARTED" "$LEARN_TIMEOUT_SECONDS")"
if [[ "$REMAINING_SECONDS" -le 0 ]]; then
  log_learn_timeout "$LEARN_TIMEOUT_MS"
  exit 0
fi
run_with_timeout "$REMAINING_SECONDS" process_transcript >/dev/null 2>&1 || true

exit 0
