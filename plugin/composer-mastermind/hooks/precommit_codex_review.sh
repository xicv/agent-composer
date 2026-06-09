#!/usr/bin/env bash
# Optional mechanical Codex pre-commit review gate (PreToolUse hook).
# Blocks Bash `git commit` only when codexReview.enabled and
# codexReview.preCommitHook.enabled are true, and the Codex review verdict
# reaches the configured blockOnSeverity threshold.
#
# Fail-open by default: reviewer/JQ/plugin/timeout failures warn to stderr and
# allow the commit unless codexReview.preCommitHook.failClosed is true.
# Config keys:
#   codexReview.preCommitCommand, scope, base
#   codexReview.preCommitHook.enabled, blockOnSeverity, timeoutMs, failClosed

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

fail_review() {
  local fail_closed="$1"
  local reason="$2"
  if [[ "$fail_closed" == "true" ]]; then
    emit_deny "codex pre-commit review unavailable (fail-closed): $reason"
  fi
  printf 'codex pre-commit review skipped: %s\n' "$reason" >&2
  exit 0
}

rank_severity() {
  case "$1" in
    critical) printf '4' ;;
    high) printf '3' ;;
    medium) printf '2' ;;
    low) printf '1' ;;
    *) printf '0' ;;
  esac
}

compact_text() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
}

find_codex_plugin_root() {
  local marketplace_root="${HOME:-}/.claude/plugins/marketplaces/openai-codex/plugins/codex"
  if [[ -f "$marketplace_root/scripts/codex-companion.mjs" ]]; then
    printf '%s\n' "$marketplace_root"
    return 0
  fi

  local cache_base="${HOME:-}/.claude/plugins/cache/openai-codex/codex"
  [[ -d "$cache_base" ]] || return 1

  local versions
  if versions="$(find "$cache_base" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null)"; then
    if printf '%s\n' "$versions" | sort -V >/dev/null 2>&1; then
      versions="$(printf '%s\n' "$versions" | sort -V)"
    else
      versions="$(printf '%s\n' "$versions" | sort)"
    fi
    local version
    while IFS= read -r version; do
      [[ -n "$version" ]] || continue
      if [[ -f "$cache_base/$version/scripts/codex-companion.mjs" ]]; then
        printf '%s\n' "$cache_base/$version"
      fi
    done <<<"$versions" | tail -n 1
  fi
}

run_reviewer() {
  local timeout_seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" "$@"
    return $?
  fi
  "$@"
}

run_reviewer_shell() {
  local timeout_seconds="$1"
  local command="$2"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" bash -c "$command"
    return $?
  fi
  bash -c "$command"
}

if ! command -v jq >/dev/null 2>&1; then
  printf 'codex pre-commit review skipped: jq missing\n' >&2
  exit 0
fi

INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  exit 0
fi

TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null || true)"
if [[ -z "$TOOL" ]]; then
  exit 0
fi
if [[ "$TOOL" != "Bash" ]]; then
  exit 0
fi

COMMAND_TEXT="$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null || true)"
if [[ -z "$COMMAND_TEXT" ]]; then
  exit 0
fi
if grep -Eq '(^|[^[:alnum:]])(commit-tree|commit-graph)([^[:alnum:]]|$)|--dry-run' <<<"$COMMAND_TEXT"; then
  exit 0
fi
if ! grep -Eq '(^|[^[:alnum:]])git([[:space:]]|[[:space:]].*[[:space:]])commit([[:space:]]|$)' <<<"$COMMAND_TEXT"; then
  exit 0
fi

CONFIG_PATH="${COMPOSER_CONFIG:-${CLAUDE_PROJECT_DIR:-.}/composer.config.json}"
if [[ ! -f "$CONFIG_PATH" ]]; then
  exit 0
fi

CONFIG_JSON="$(cat "$CONFIG_PATH" 2>/dev/null || true)"
if [[ -z "$CONFIG_JSON" ]] || ! jq -e . >/dev/null 2>&1 <<<"$CONFIG_JSON"; then
  exit 0
fi

ENABLED="$(jq -r '.codexReview.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
HOOK_ENABLED="$(jq -r '.codexReview.preCommitHook.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
if [[ "$ENABLED" != "true" || "$HOOK_ENABLED" != "true" ]]; then
  exit 0
fi

REVIEW_COMMAND="$(jq -r '.codexReview.preCommitCommand // "review"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'review')"
SCOPE="$(jq -r '.codexReview.scope // "working-tree"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'working-tree')"
BASE="$(jq -r '.codexReview.base // "main"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'main')"
BLOCK_ON_SEVERITY="$(jq -r '.codexReview.preCommitHook.blockOnSeverity // "high"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'high')"
TIMEOUT_MS="$(jq -r '.codexReview.preCommitHook.timeoutMs // 120000' <<<"$CONFIG_JSON" 2>/dev/null || printf '120000')"
FAIL_CLOSED="$(jq -r '.codexReview.preCommitHook.failClosed // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"

case "$REVIEW_COMMAND" in
  review|adversarial-review) ;;
  *) fail_review "$FAIL_CLOSED" "invalid preCommitCommand: $REVIEW_COMMAND" ;;
esac
case "$BLOCK_ON_SEVERITY" in
  critical|high|medium|low) ;;
  *) fail_review "$FAIL_CLOSED" "invalid blockOnSeverity: $BLOCK_ON_SEVERITY" ;;
esac
case "$TIMEOUT_MS" in
  ''|*[!0-9]*) fail_review "$FAIL_CLOSED" "invalid timeoutMs: $TIMEOUT_MS" ;;
esac

TIMEOUT_SECONDS=$(( (TIMEOUT_MS + 999) / 1000 ))
if [[ "$TIMEOUT_SECONDS" -lt 1 ]]; then
  TIMEOUT_SECONDS=1
fi

REVIEW_OUTPUT=""
REVIEW_STATUS=0
if [[ -n "${COMPOSER_CODEX_REVIEW_CMD:-}" ]]; then
  REVIEW_OUTPUT="$(run_reviewer_shell "$TIMEOUT_SECONDS" "$COMPOSER_CODEX_REVIEW_CMD" 2>/dev/null)"
  REVIEW_STATUS=$?
else
  CODEX_ROOT="$(find_codex_plugin_root || true)"
  if [[ -z "$CODEX_ROOT" ]]; then
    fail_review "$FAIL_CLOSED" "codex companion not found"
  fi
  REVIEW_ARGS=("node" "$CODEX_ROOT/scripts/codex-companion.mjs" "$REVIEW_COMMAND" "--wait" "--json" "--scope" "$SCOPE")
  if [[ "$SCOPE" == "branch" ]]; then
    REVIEW_ARGS+=("--base" "$BASE")
  fi
  REVIEW_OUTPUT="$(run_reviewer "$TIMEOUT_SECONDS" "${REVIEW_ARGS[@]}" 2>/dev/null)"
  REVIEW_STATUS=$?
fi

if [[ "$REVIEW_STATUS" -eq 124 ]]; then
  fail_review "$FAIL_CLOSED" "review timed out after ${TIMEOUT_SECONDS}s"
fi
if [[ "$REVIEW_STATUS" -ne 0 ]]; then
  fail_review "$FAIL_CLOSED" "review command exited $REVIEW_STATUS"
fi
if [[ -z "$REVIEW_OUTPUT" ]]; then
  fail_review "$FAIL_CLOSED" "review returned empty output"
fi
if ! jq -e . >/dev/null 2>&1 <<<"$REVIEW_OUTPUT"; then
  fail_review "$FAIL_CLOSED" "review returned unparseable JSON"
fi

VERDICT="$(jq -r '.verdict // empty' <<<"$REVIEW_OUTPUT" 2>/dev/null || true)"
case "$VERDICT" in
  approve)
    printf 'codex pre-commit review: approve\n' >&2
    exit 0
    ;;
  needs-attention)
    ;;
  *)
    fail_review "$FAIL_CLOSED" "unknown review verdict: ${VERDICT:-missing}"
    ;;
esac

SUMMARY="$(jq -r '.summary // empty' <<<"$REVIEW_OUTPUT" 2>/dev/null || true)"
SUMMARY="$(compact_text "$SUMMARY")"
SUMMARY="${SUMMARY:0:200}"
FINDING_COUNT="$(jq -r 'if (.findings | type) == "array" then (.findings | length) else 0 end' <<<"$REVIEW_OUTPUT" 2>/dev/null || printf '0')"

if [[ "$FINDING_COUNT" -eq 0 ]]; then
  emit_deny "Codex pre-commit review: needs-attention. $SUMMARY"
fi

MAX_RANK="$(jq -r '
  def rank: if . == "critical" then 4 elif . == "high" then 3 elif . == "medium" then 2 elif . == "low" then 1 else 0 end;
  [.findings[]?.severity | rank] | max // 0
' <<<"$REVIEW_OUTPUT" 2>/dev/null || printf '0')"
THRESHOLD_RANK="$(rank_severity "$BLOCK_ON_SEVERITY")"

if [[ "$MAX_RANK" -lt "$THRESHOLD_RANK" ]]; then
  printf 'codex pre-commit review: needs-attention but all findings below %s; allowing\n' "$BLOCK_ON_SEVERITY" >&2
  exit 0
fi

FINDING_SUMMARY="$(jq -r '
  .findings[:3]
  | map(
      "[" + (.severity // "unknown") + "] "
      + (.file // "<unknown>") + ":"
      + ((.line_start // 0) | tostring) + " "
      + (.title // "<untitled>")
    )
  | join(" | ")
' <<<"$REVIEW_OUTPUT" 2>/dev/null || true)"
FINDING_SUMMARY="$(compact_text "$FINDING_SUMMARY")"

emit_deny "Codex pre-commit review: needs-attention (>= $BLOCK_ON_SEVERITY). $SUMMARY | $FINDING_SUMMARY"
