#!/usr/bin/env bash
# Optional mechanical Codex pre-commit review gate (PreToolUse hook).
# Blocks Bash `git commit` only when codexReview.enabled and
# codexReview.preCommitHook.enabled are true, and the Codex review verdict
# reaches the configured blockOnSeverity threshold.
#
# Fail-open by default: reviewer/JQ/plugin failures warn to stderr and allow the
# commit unless codexReview.preCommitHook.failClosed is true. EXCEPTION: a review
# timeout/hang ALWAYS fails closed (blocks the commit) so a slow or hung reviewer
# cannot bypass the gate; raise preCommitHook.timeoutMs if reviews need more time.
# Config keys:
#   codexReview.preCommitCommand, scope, base, model
#   codexReview.preCommitHook.enabled, blockOnSeverity, timeoutMs, failClosed, maxConsecutiveBlocks
#   codexReview.warmCache.enabled, maxAgeMinutes
#   codexReview.notify.desktop

set -u

RUN_LOG="${RUN_LOG:-/tmp/composer-codex-review-log.jsonl}"
PRECOMMIT_DEFAULT_TIMEOUT_MS=120000
PRECOMMIT_MIN_HARD_CAP_MS=120000
PRECOMMIT_MAX_HARD_CAP_MS=180000

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

json_escape_fallback() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

emit_json() {
  local message="$1"
  if [[ "${GITHOOK:-0}" == "1" ]]; then
    printf '%s\n' "$message" >&2
    return 0
  fi
  jq -nc --arg systemMessage "$message" \
    '{systemMessage:$systemMessage,suppressOutput:true}' 2>/dev/null \
    || printf '{"systemMessage":"%s","suppressOutput":true}\n' "$(json_escape_fallback "$message")"
}

emit_deny() {
  local reason="$1"
  local message="${2:-$reason}"
  if [[ "${GITHOOK:-0}" == "1" ]]; then
    printf '%s\n' "$message" >&2
    printf 'commit blocked by Codex pre-commit review: %s\n' "$reason" >&2
    exit 1
  fi
  jq -nc --arg r "$reason" --arg systemMessage "$message" \
    '{systemMessage:$systemMessage,suppressOutput:true,hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '{"systemMessage":"%s","suppressOutput":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(json_escape_fallback "$message")" "$(json_escape_fallback "$reason")"
  exit 0
}

append_run_log() {
  local verdict="$1"
  local decision="$2"
  local source="$3"
  local duration_ms="$4"
  local findings="$5"
  local scope="$6"
  local diff_hash="$7"
  local reason_code="${8:-}"
  local stage="${9:-precommit_codex_review}"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg verdict "$verdict" \
    --arg decision "$decision" \
    --arg source "$source" \
    --arg scope "$scope" \
    --arg diff_hash "$diff_hash" \
    --arg reason_code "$reason_code" \
    --arg stage "$stage" \
    --argjson duration_ms "${duration_ms:-0}" \
    --argjson findings "${findings:-0}" \
    '{ts:$ts,verdict:$verdict,decision:$decision,source:$source,duration_ms:$duration_ms,elapsed_wall_ms:$duration_ms,findings:$findings,scope:$scope,diff_hash:$diff_hash,stage:$stage,reason_code:(if $reason_code == "" then null else $reason_code end)}' \
    >> "$RUN_LOG" 2>/dev/null || true
}

fail_review() {
  local fail_closed="$1"
  local reason="$2"
  local duration_ms="${3:-0}"
  local reason_code="${4:-review_unavailable}"
  if [[ "$fail_closed" == "true" ]]; then
    append_run_log "error" "deny" "sync" "$duration_ms" 0 "${SCOPE:-}" "${DIFF_HASH:-}" "$reason_code"
    emit_deny "codex pre-commit review unavailable (fail-closed): $reason" "⛔ Codex review unavailable (fail-closed): $reason"
  fi
  printf 'codex pre-commit review skipped: %s\n' "$reason" >&2
  append_run_log "skip" "allow" "sync" "$duration_ms" 0 "${SCOPE:-}" "${DIFF_HASH:-}" "$reason_code"
  emit_json "⚠️ Codex pre-commit review skipped: $reason — commit allowed (fail-open)"
  exit 0
}

resolve_precommit_hard_cap_ms() {
  local configured="${COMPOSER_PRECOMMIT_HOOK_MAX_TIMEOUT_MS:-$PRECOMMIT_MAX_HARD_CAP_MS}"
  case "$configured" in
    ''|*[!0-9]*) configured="$PRECOMMIT_MAX_HARD_CAP_MS" ;;
  esac
  if [[ "$configured" -lt "$PRECOMMIT_MIN_HARD_CAP_MS" ]]; then
    configured="$PRECOMMIT_MIN_HARD_CAP_MS"
  elif [[ "$configured" -gt "$PRECOMMIT_MAX_HARD_CAP_MS" ]]; then
    configured="$PRECOMMIT_MAX_HARD_CAP_MS"
  fi
  printf '%s\n' "$configured"
}

normalize_precommit_timeout_ms() {
  local requested="$1"
  local cap
  cap="$(resolve_precommit_hard_cap_ms)"
  if [[ "$requested" -gt "$cap" ]]; then
    printf '%s\n' "$cap"
  else
    printf '%s\n' "$requested"
  fi
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

severity_for_rank() {
  case "$1" in
    4) printf 'critical' ;;
    3) printf 'high' ;;
    2) printf 'medium' ;;
    1) printf 'low' ;;
    *) printf 'unknown' ;;
  esac
}

compact_text() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
}

hash_stdin_16() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print substr($1,1,16)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print substr($1,1,16)}'
  else
    return 1
  fi
}

git_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 git "$@"
  else
    git "$@"
  fi
}

compute_repo_hash() {
  printf '%s' "$1" | hash_stdin_16
}

ensure_state_dir() {
  local dir="${COMPOSER_STATE_DIR:-${HOME:-}/.cache/composer}"
  [[ -n "$dir" ]] || return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  chmod 700 "$dir" 2>/dev/null || return 1
  [[ -d "$dir" ]] || return 1
  printf '%s\n' "$dir"
}

cache_file_is_trusted() {
  local cache_file="$1"
  [[ -f "$cache_file" && ! -L "$cache_file" ]] || return 1

  local owner mode current_uid group_digit other_digit stat_out
  current_uid="$(id -u 2>/dev/null)" || return 1
  if stat_out="$(stat -f '%u %Lp' "$cache_file" 2>/dev/null)"; then
    owner="${stat_out%% *}"
    mode="${stat_out##* }"
  elif stat_out="$(stat -c '%u %a' "$cache_file" 2>/dev/null)"; then
    owner="${stat_out%% *}"
    mode="${stat_out##* }"
  else
    return 1
  fi

  [[ "$owner" == "$current_uid" ]] || return 1
  [[ "$mode" =~ ^[0-7]+$ ]] || return 1
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1}"
  (( (10#$group_digit & 2) == 0 && (10#$other_digit & 2) == 0 )) || return 1
  return 0
}

compute_diff_hash() {
  local root="$1"
  local pre_commit_command="$2"
  local scope="$3"
  local base="$4"
  local model="$5"
  local base_ref merge_base branch_diff
  # blockOnSeverity is excluded because threshold is re-applied at gate-read time from the cached findings array.
  {
    git_timeout -C "$root" diff HEAD 2>/dev/null
    git_timeout -C "$root" diff --cached 2>/dev/null
    if [[ "$scope" == "branch" ]]; then
      if base_ref="$(git_timeout -C "$root" rev-parse --verify "${base}^{commit}" 2>/dev/null)" \
        && merge_base="$(git_timeout -C "$root" merge-base "$base" HEAD 2>/dev/null)" \
        && branch_diff="$(git_timeout -C "$root" diff "$base...HEAD" 2>/dev/null)"; then
        printf '\ncomposer-codex-review-branch\nbaseRef=%s\nmergeBase=%s\n' "$base_ref" "$merge_base"
        printf '%s' "$branch_diff"
        printf '\n'
      fi
    fi
    printf '\ncomposer-codex-review-policy\npreCommitCommand=%s\nscope=%s\nbase=%s\nmodel=%s\n' "$pre_commit_command" "$scope" "$base" "$model"
  } | hash_stdin_16
}

find_git_root() {
  local start="${CLAUDE_PROJECT_DIR:-.}"
  git_timeout -C "$start" rev-parse --show-toplevel 2>/dev/null || git_timeout rev-parse --show-toplevel 2>/dev/null
}

find_codex_plugin_root() {
  if [[ -n "${COMPOSER_CODEX_PLUGIN_ROOT:-}" && -f "$COMPOSER_CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" ]]; then
    printf '%s\n' "$COMPOSER_CODEX_PLUGIN_ROOT"
    return 0
  fi

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

# kill_tree: fallback teardown when no process group could be created. STOP
# each node BEFORE enumerating its children so it cannot fork a new child
# mid-teardown (the race), then CONT so a delivered TERM is actually acted
# on. Note: a descendant that has already reparented (double-fork) is not
# reachable via pgrep -P walking — the process-group path below handles that.
kill_tree() {
  local sig="$1" root="$2" child
  kill -STOP "$root" 2>/dev/null || true
  for child in $(pgrep -P "$root" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  kill -"$sig" "$root" 2>/dev/null || true
  kill -CONT "$root" 2>/dev/null || true
}

# teardown_reviewer: prefer an ATOMIC process-group signal (kill -SIG -PGID)
# when the reviewer leads its own group — this also reaches descendants that
# reparented away from the immediate child. Fall back to kill_tree otherwise.
teardown_reviewer() {
  local sig="$1" pid="$2" pgid_mode="$3"
  if [[ "$pgid_mode" == "1" ]] && kill -"$sig" "-$pid" 2>/dev/null; then
    return 0
  fi
  kill_tree "$sig" "$pid"
}

run_reviewer() {
  local timeout_seconds="$1"
  shift

  local pid watchdog status marker pgid_mode
  marker="${TMPDIR:-/tmp}/composer-timeout.$$.$RANDOM"
  # Launch the reviewer as the leader of a NEW process group so the watchdog
  # can signal the whole subtree atomically (catching reparented grandchildren
  # that hold the stdout pipe). setsid (Linux) or perl setpgrp (portable;
  # ships on macOS where setsid does not) make the child its own group leader.
  # If neither exists, fall back to in-group launch + kill_tree teardown.
  pgid_mode=0
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
    pid=$!
    pgid_mode=1
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'setpgrp(0,0); exec @ARGV or die "exec failed: $!"' "$@" &
    pid=$!
    pgid_mode=1
  else
    "$@" &
    pid=$!
  fi
  (
    sleeper=""
    trap '[[ -n "$sleeper" ]] && kill "$sleeper" 2>/dev/null || true; exit 0' TERM INT
    sleep "$timeout_seconds" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null || exit 0
    printf '1' >"$marker" 2>/dev/null || true
    teardown_reviewer TERM "$pid" "$pgid_mode"
    sleep 5
    teardown_reviewer KILL "$pid" "$pgid_mode"
  ) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [[ -f "$marker" ]]; then
    rm -f "$marker" 2>/dev/null || true
    return 124
  fi
  rm -f "$marker" 2>/dev/null || true
  return "$status"
}

run_reviewer_shell() {
  local timeout_seconds="$1"
  local command="$2"
  run_reviewer "$timeout_seconds" bash -c "$command"
}

notify_desktop() {
  local message="$1"
  [[ "${NOTIFY_DESKTOP:-false}" == "true" ]] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"$(json_escape_fallback "$message")\" with title \"Composer\"" >/dev/null 2>&1 &
}

cache_is_fresh_match() {
  local cache_file="$1"
  local diff_hash="$2"
  local max_age_minutes="$3"
  [[ -f "$cache_file" ]] || return 1
  jq -e --arg hash "$diff_hash" --argjson maxAge "$max_age_minutes" '
    (.hash == $hash)
    and ((.ts | type) == "string")
    and ((now - (.ts | fromdateiso8601)) <= ($maxAge * 60))
  ' "$cache_file" >/dev/null 2>&1
}

write_cache() {
  local cache_file="$1"
  local diff_hash="$2"
  local review_output="$3"
  local duration_ms="$4"
  local verdict
  verdict="$(jq -r '.verdict // empty' <<<"$review_output" 2>/dev/null || true)"
  case "$verdict" in
    approve|needs-attention) ;;
    *) return 0 ;;
  esac
  local tmp="${cache_file}.$$"
  jq -nc \
    --arg hash "$diff_hash" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson review "$review_output" \
    --argjson durationMs "$duration_ms" \
    '{hash:$hash, verdict:($review.verdict // "error"), summary:($review.summary // ""), findings:(if ($review.findings | type) == "array" then $review.findings else [] end), ts:$ts, durationMs:$durationMs}' \
    > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null && mv "$tmp" "$cache_file" 2>/dev/null || rm -f "$tmp"
}

compute_work_hash() {
  local root="$1"
  local base="$2"
  local branch
  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
  printf 'branch=%s\nbase=%s\n' "$branch" "$base" | hash_stdin_16
}

read_block_counter() {
  local counter_file="$1"
  if ! cache_file_is_trusted "$counter_file"; then
    printf '0'
    return 0
  fi
  jq -r 'if (.count | type) == "number" and (.count >= 0) then (.count | floor) else 0 end' \
    "$counter_file" 2>/dev/null || printf '0'
}

write_block_counter() {
  local counter_file="$1"
  local count="$2"
  local tmp="${counter_file}.$$"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson count "$count" \
    '{count:$count,ts:$ts}' \
    > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null && mv "$tmp" "$counter_file" 2>/dev/null || rm -f "$tmp"
}

reset_block_counter() {
  local counter_file="${BLOCK_COUNTER_FILE:-}"
  [[ -n "$counter_file" ]] || return 0
  rm -f "$counter_file" 2>/dev/null || true
}

maybe_allow_after_block_cap() {
  local source="$1"
  local duration_ms="$2"
  local findings="$3"
  local duration_s="$4"

  [[ "${MAX_CONSECUTIVE_BLOCKS:-0}" =~ ^[0-9]+$ ]] || return 1
  [[ "$MAX_CONSECUTIVE_BLOCKS" -gt 0 ]] || return 1
  [[ -n "${BLOCK_COUNTER_FILE:-}" ]] || return 1

  local current_count next_count
  current_count="$(read_block_counter "$BLOCK_COUNTER_FILE")"
  [[ "$current_count" =~ ^[0-9]+$ ]] || current_count=0

  if [[ "$current_count" -ge "$MAX_CONSECUTIVE_BLOCKS" ]]; then
    reset_block_counter
    notify_desktop "Codex pre-commit review allowed after oscillation cap"
    append_run_log "needs-attention" "allow-cap" "$source" "$duration_ms" "$findings" "$SCOPE" "${DIFF_HASH:-}"
    emit_json "⚠️ Codex gate: allowed after ${current_count} consecutive blocks (oscillation cap reached) — review the diff manually / see the PR (${duration_s}s)"
    exit 0
  fi

  next_count=$((current_count + 1))
  write_block_counter "$BLOCK_COUNTER_FILE" "$next_count"
  return 1
}

review_from_cache() {
  local cache_file="$1"
  jq -c '{verdict:(.verdict // "error"), summary:(.summary // ""), findings:(if (.findings | type) == "array" then .findings else [] end), next_steps:[]}' "$cache_file" 2>/dev/null
}

cache_age_minutes() {
  local cache_file="$1"
  jq -r '((now - (.ts | fromdateiso8601)) / 60 | floor)' "$cache_file" 2>/dev/null || printf '0'
}

review_parse_error_message() {
  local review_output="$1"
  jq -r '
    def parsed_json($value):
      if ($value | type) == "string" then (($value | fromjson?) // {}) else {} end;
    def first_error($items):
      [
        $items[]
        | select(. != null and . != false and ((. | tostring) | length) > 0)
      ]
      | first // "";

    (parsed_json(.rawOutput? // null)) as $rawOutputJson
    | (parsed_json(.codex.stdout? // null)) as $codexStdoutJson
    | first_error([
        .parseError?,
        .result.parseError?,
        .review?.parseError?,
        .review?.result?.parseError?,
        .data?.parseError?,
        .data?.result?.parseError?,
        .output?.parseError?,
        .output?.result?.parseError?,
        .response?.parseError?,
        .response?.result?.parseError?,
        .payload?.parseError?,
        .payload?.result?.parseError?,
        $rawOutputJson.parseError?,
        $rawOutputJson.result.parseError?,
        $codexStdoutJson.parseError?,
        $codexStdoutJson.result.parseError?
      ])
  ' <<<"$review_output" 2>/dev/null
}

normalize_review_output() {
  local review_output="$1"
  jq -c '
    def parsed_json($value):
      if ($value | type) == "string" then (($value | fromjson?) // {}) else {} end;
    def first_value($items):
      [
        $items[]
        | select(. != null and . != "")
      ]
      | first // null;
    def first_text($items):
      [
        $items[]
        | select((. | type) == "string" and length > 0)
      ]
      | first // "";
    def first_array($items):
      [
        $items[]
        | select((. | type) == "array")
      ]
      | first // [];

    (parsed_json(.rawOutput? // null)) as $rawOutputJson
    | (parsed_json(.codex.stdout? // null)) as $codexStdoutJson
    | (parsed_json(.stdout? // null)) as $stdoutJson
    | {
      verdict: first_value([
        .result.verdict?,
        .verdict?,
        .review?.result?.verdict?,
        .review?.verdict?,
        .data?.result?.verdict?,
        .data?.verdict?,
        .output?.result?.verdict?,
        .output?.verdict?,
        .response?.result?.verdict?,
        .response?.verdict?,
        .payload?.result?.verdict?,
        .payload?.verdict?,
        $rawOutputJson.result.verdict?,
        $rawOutputJson.verdict?,
        $rawOutputJson.review?.result?.verdict?,
        $rawOutputJson.review?.verdict?,
        $codexStdoutJson.result.verdict?,
        $codexStdoutJson.verdict?,
        $codexStdoutJson.review?.result?.verdict?,
        $codexStdoutJson.review?.verdict?,
        $stdoutJson.result.verdict?,
        $stdoutJson.verdict?
      ]),
      summary: (first_text([
        .result.summary?,
        .summary?,
        .review?.result?.summary?,
        .review?.summary?,
        .data?.result?.summary?,
        .data?.summary?,
        .output?.result?.summary?,
        .output?.summary?,
        .response?.result?.summary?,
        .response?.summary?,
        .payload?.result?.summary?,
        .payload?.summary?,
        $rawOutputJson.result.summary?,
        $rawOutputJson.summary?,
        $rawOutputJson.review?.result?.summary?,
        $rawOutputJson.review?.summary?,
        $codexStdoutJson.result.summary?,
        $codexStdoutJson.summary?,
        $codexStdoutJson.review?.result?.summary?,
        $codexStdoutJson.review?.summary?,
        $stdoutJson.result.summary?,
        $stdoutJson.summary?
      ]) // ""),
      findings: first_array([
        .result.findings?,
        .findings?,
        .review?.result?.findings?,
        .review?.findings?,
        .data?.result?.findings?,
        .data?.findings?,
        .output?.result?.findings?,
        .output?.findings?,
        .response?.result?.findings?,
        .response?.findings?,
        .payload?.result?.findings?,
        .payload?.findings?,
        $rawOutputJson.result.findings?,
        $rawOutputJson.findings?,
        $rawOutputJson.review?.result?.findings?,
        $rawOutputJson.review?.findings?,
        $codexStdoutJson.result.findings?,
        $codexStdoutJson.findings?,
        $codexStdoutJson.review?.result?.findings?,
        $codexStdoutJson.review?.findings?,
        $stdoutJson.result.findings?,
        $stdoutJson.findings?
      ]),
      next_steps: first_array([
        .result.next_steps?,
        .next_steps?,
        .review?.result?.next_steps?,
        .review?.next_steps?,
        .data?.result?.next_steps?,
        .data?.next_steps?,
        .output?.result?.next_steps?,
        .output?.next_steps?,
        .response?.result?.next_steps?,
        .response?.next_steps?,
        .payload?.result?.next_steps?,
        .payload?.next_steps?,
        $rawOutputJson.result.next_steps?,
        $rawOutputJson.next_steps?,
        $rawOutputJson.review?.result?.next_steps?,
        $rawOutputJson.review?.next_steps?,
        $codexStdoutJson.result.next_steps?,
        $codexStdoutJson.next_steps?,
        $codexStdoutJson.review?.result?.next_steps?,
        $codexStdoutJson.review?.next_steps?,
        $stdoutJson.result.next_steps?,
        $stdoutJson.next_steps?
      ]),
      raw_text: first_text([
        .codex.stdout?,
        .rawOutput?,
        .stdout?,
        .review?
      ])
    }
  ' <<<"$review_output" 2>/dev/null
}

evaluate_review_output() {
  local review_output="$1"
  local source="$2"
  local duration_ms="$3"
  local cache_age="${4:-0}"
  local duration_s=$(( (duration_ms + 999) / 1000 ))

  if ! jq -e . >/dev/null 2>&1 <<<"$review_output"; then
    fail_review "$FAIL_CLOSED" "review returned unparseable JSON" "$duration_ms"
  fi

  local verdict
  verdict="$(jq -r '.verdict // empty' <<<"$review_output" 2>/dev/null || true)"
  case "$verdict" in
    approve)
      printf 'codex pre-commit review: approve\n' >&2
      reset_block_counter
      append_run_log "approve" "allow" "$source" "$duration_ms" 0 "$SCOPE" "${DIFF_HASH:-}"
      if [[ "$source" == "cache" ]]; then
        emit_json "✅ Codex pre-commit review: approve (cached, ${cache_age}m old)"
      else
        emit_json "✅ Codex pre-commit review: approve (${duration_s}s)"
      fi
      exit 0
      ;;
    needs-attention)
      ;;
    *)
      local raw_text_len
      raw_text_len="$(jq -r '(.raw_text // "" | length)' <<<"$review_output" 2>/dev/null || printf '0')"
      if [[ -z "$verdict" && "$raw_text_len" =~ ^[0-9]+$ && "$raw_text_len" -gt 0 ]]; then
        fail_review "$FAIL_CLOSED" "structured review verdict missing; use codexReview.preCommitCommand=adversarial-review for mechanical gates" "$duration_ms"
      fi
      fail_review "$FAIL_CLOSED" "unknown review verdict: ${verdict:-missing}" "$duration_ms"
      ;;
  esac

  local summary finding_count max_rank threshold_rank max_severity
  summary="$(jq -r '.summary // empty' <<<"$review_output" 2>/dev/null || true)"
  summary="$(compact_text "$summary")"
  summary="${summary:0:200}"
  finding_count="$(jq -r 'if (.findings | type) == "array" then (.findings | length) else 0 end' <<<"$review_output" 2>/dev/null || printf '0')"

  max_rank="$(jq -r '
    def rank: if . == "critical" then 4 elif . == "high" then 3 elif . == "medium" then 2 elif . == "low" then 1 else 0 end;
    [.findings[]?.severity | rank] | max // 0
  ' <<<"$review_output" 2>/dev/null || printf '0')"
  threshold_rank="$(rank_severity "$BLOCK_ON_SEVERITY")"
  max_severity="$(severity_for_rank "$max_rank")"

  if [[ "$finding_count" -eq 0 || "$max_rank" -ge "$threshold_rank" ]]; then
    local finding_summary
    finding_summary="$(jq -r '
      .findings[:3]
      | map(
          "[" + (.severity // "unknown") + "] "
          + (.file // "<unknown>") + ":"
          + ((.line_start // 0) | tostring) + " "
          + (.title // "<untitled>")
        )
      | join(" | ")
    ' <<<"$review_output" 2>/dev/null || true)"
    finding_summary="$(compact_text "$finding_summary")"
    maybe_allow_after_block_cap "$source" "$duration_ms" "$finding_count" "$duration_s"
    notify_desktop "Codex pre-commit review blocked: ${max_severity}"
    append_run_log "needs-attention" "deny" "$source" "$duration_ms" "$finding_count" "$SCOPE" "${DIFF_HASH:-}"
    emit_deny "Codex pre-commit review: needs-attention (>= $BLOCK_ON_SEVERITY). $summary | $finding_summary" "⛔ Codex pre-commit review: blocked (${max_severity}, ${duration_s}s)"
  fi

  printf 'codex pre-commit review: needs-attention but all findings below %s; allowing\n' "$BLOCK_ON_SEVERITY" >&2
  reset_block_counter
  append_run_log "needs-attention" "allow" "$source" "$duration_ms" "$finding_count" "$SCOPE" "${DIFF_HASH:-}"
  emit_json "🟡 Codex pre-commit review: needs-attention below ${BLOCK_ON_SEVERITY} threshold — allowing (${duration_s}s)"
  exit 0
}

GITHOOK=0
if [[ "${1:-}" == "--git-hook" || "${COMPOSER_PRECOMMIT_GITHOOK:-}" == "1" ]]; then
  GITHOOK=1
fi

if [[ "$GITHOOK" == "1" ]]; then
  # Real git pre-commit hook: git provides no PreToolUse JSON on stdin. jq is
  # still needed to parse config; if it is missing, honor failClosed via Node.
  if ! command -v jq >/dev/null 2>&1; then
    PREFLIGHT_CONFIG_PATH="${COMPOSER_CONFIG:-${CLAUDE_PROJECT_DIR:-.}/composer.config.json}"
    PREFLIGHT_FLAGS="0 0"
    if [[ -f "$PREFLIGHT_CONFIG_PATH" ]] && command -v node >/dev/null 2>&1; then
      PREFLIGHT_FLAGS="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=c.codexReview||{};const h=r.preCommitHook||{};process.stdout.write((r.enabled===true&&h.enabled===true?"1":"0")+" "+(h.failClosed===true?"1":"0"))}catch(e){process.stdout.write("0 0")}' "$PREFLIGHT_CONFIG_PATH" 2>/dev/null || printf '0 0')"
    fi
    if [[ "${PREFLIGHT_FLAGS%% *}" == "1" && "${PREFLIGHT_FLAGS##* }" == "1" ]]; then
      emit_deny "codex pre-commit review unavailable: jq not installed (fail-closed)" "⛔ Codex pre-commit gate requires jq (fail-closed). Install jq (brew install jq)."
    fi
    printf 'codex pre-commit review skipped: jq not installed\n' >&2
    exit 0
  fi
else
  INPUT="$(cat || true)"
  if [[ -z "$INPUT" ]]; then
    exit 0
  fi

  # jq is required to parse the hook payload. If it is missing we cannot run the
  # gate; honor failClosed via a jq-free (Node) config read so a configured
  # fail-closed gate cannot silently fail open. Only an actual Bash `git commit`
  # payload is gated; everything else is allowed through unchanged.
  if ! command -v jq >/dev/null 2>&1; then
    if grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"Bash"' <<<"$INPUT" \
       && grep -Eq 'git[^"]*commit' <<<"$INPUT"; then
      PREFLIGHT_CONFIG_PATH="${COMPOSER_CONFIG:-${CLAUDE_PROJECT_DIR:-.}/composer.config.json}"
      PREFLIGHT_FLAGS="0 0"
      if [[ -f "$PREFLIGHT_CONFIG_PATH" ]] && command -v node >/dev/null 2>&1; then
        PREFLIGHT_FLAGS="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=c.codexReview||{};const h=r.preCommitHook||{};process.stdout.write((r.enabled===true&&h.enabled===true?"1":"0")+" "+(h.failClosed===true?"1":"0"))}catch(e){process.stdout.write("0 0")}' "$PREFLIGHT_CONFIG_PATH" 2>/dev/null || printf '0 0')"
      fi
      if [[ "${PREFLIGHT_FLAGS%% *}" == "1" && "${PREFLIGHT_FLAGS##* }" == "1" ]]; then
        emit_deny "codex pre-commit review unavailable: jq not installed (fail-closed)" "⛔ Codex pre-commit gate requires jq (fail-closed). Install jq (brew install jq)."
      fi
    fi
    printf 'codex pre-commit review skipped: jq not installed\n' >&2
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
fi

# Library mode: allow tests to source helpers without running the gate.
if [[ "${COMPOSER_PRECOMMIT_LIB_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
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
CODEX_MODEL="$(jq -r '.codexReview.model // empty' <<<"$CONFIG_JSON" 2>/dev/null || true)"
BLOCK_ON_SEVERITY="$(jq -r '.codexReview.preCommitHook.blockOnSeverity // "high"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'high')"
TIMEOUT_MS="$(jq -r ".codexReview.preCommitHook.timeoutMs // $PRECOMMIT_DEFAULT_TIMEOUT_MS" <<<"$CONFIG_JSON" 2>/dev/null || printf '%s' "$PRECOMMIT_DEFAULT_TIMEOUT_MS")"
FAIL_CLOSED="$(jq -r '.codexReview.preCommitHook.failClosed // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
MAX_CONSECUTIVE_BLOCKS="$(jq -r '(.codexReview.preCommitHook.maxConsecutiveBlocks // 0) | if type == "number" and . >= 0 and . == floor then . else 0 end' <<<"$CONFIG_JSON" 2>/dev/null || printf '0')"
WARM_CACHE_ENABLED="$(jq -r '.codexReview.warmCache.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
WARM_CACHE_MAX_AGE_MINUTES="$(jq -r '.codexReview.warmCache.maxAgeMinutes // 30' <<<"$CONFIG_JSON" 2>/dev/null || printf '30')"
NOTIFY_DESKTOP="$(jq -r '.codexReview.notify.desktop // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"

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
TIMEOUT_MS="$(normalize_precommit_timeout_ms "$TIMEOUT_MS")"
case "$MAX_CONSECUTIVE_BLOCKS" in
  ''|*[!0-9]*) MAX_CONSECUTIVE_BLOCKS=0 ;;
esac
if [[ "$(printf '%s' "$CODEX_MODEL" | tr '[:upper:]' '[:lower:]')" == "gpt-5.5-pro" ]]; then
  fail_review "$FAIL_CLOSED" "gpt-5.5-pro is the ChatGPT-Pro/Oracle browser lane, not a Codex CLI model"
fi
case "$WARM_CACHE_MAX_AGE_MINUTES" in
  ''|*[!0-9]*) WARM_CACHE_MAX_AGE_MINUTES=30 ;;
esac

TIMEOUT_SECONDS=$(( (TIMEOUT_MS + 999) / 1000 ))
if [[ "$TIMEOUT_SECONDS" -lt 1 ]]; then
  TIMEOUT_SECONDS=1
fi

DIFF_HASH=""
CACHE_FILE=""
BLOCK_COUNTER_FILE=""
GIT_ROOT="$(find_git_root || true)"
if [[ -n "$GIT_ROOT" && "$MAX_CONSECUTIVE_BLOCKS" -gt 0 ]]; then
  REPO_HASH="$(compute_repo_hash "$GIT_ROOT" 2>/dev/null || true)"
  WORK_HASH="$(compute_work_hash "$GIT_ROOT" "$BASE" 2>/dev/null || true)"
  STATE_DIR="$(ensure_state_dir 2>/dev/null || true)"
  if [[ -n "$REPO_HASH" && -n "$WORK_HASH" && -n "$STATE_DIR" ]]; then
    BLOCK_COUNTER_FILE="$STATE_DIR/codex-review-blocks-${REPO_HASH}-${WORK_HASH}.json"
  fi
fi
if [[ -n "${COMPOSER_CODEX_REVIEW_CMD:-}" ]]; then
  : # Test seam commands are not equivalent reviewer policy, so they never read or write warm-cache verdicts.
elif [[ "$WARM_CACHE_ENABLED" == "true" ]]; then
  if [[ -n "$GIT_ROOT" ]]; then
    REPO_HASH="$(compute_repo_hash "$GIT_ROOT" 2>/dev/null || true)"
    DIFF_HASH="$(compute_diff_hash "$GIT_ROOT" "$REVIEW_COMMAND" "$SCOPE" "$BASE" "$CODEX_MODEL" 2>/dev/null || true)"
    STATE_DIR="$(ensure_state_dir 2>/dev/null || true)"
    if [[ -n "$REPO_HASH" && -n "$DIFF_HASH" && -n "$STATE_DIR" ]]; then
      CACHE_FILE="$STATE_DIR/codex-review-cache-${REPO_HASH}.json"
      if cache_file_is_trusted "$CACHE_FILE" && cache_is_fresh_match "$CACHE_FILE" "$DIFF_HASH" "$WARM_CACHE_MAX_AGE_MINUTES"; then
        CACHE_OUTPUT="$(review_from_cache "$CACHE_FILE" || true)"
        CACHE_AGE="$(cache_age_minutes "$CACHE_FILE")"
        if [[ -n "$CACHE_OUTPUT" ]]; then
          evaluate_review_output "$CACHE_OUTPUT" "cache" 0 "$CACHE_AGE"
        fi
      fi
    fi
  fi
fi

REVIEW_OUTPUT=""
REVIEW_STATUS=0
START_SECONDS="$(date +%s)"
notify_desktop "Codex pre-commit review running…"
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
  if [[ -n "$CODEX_MODEL" ]]; then
    REVIEW_ARGS+=("--model" "$CODEX_MODEL")
  fi
  REVIEW_OUTPUT="$(run_reviewer "$TIMEOUT_SECONDS" "${REVIEW_ARGS[@]}" 2>/dev/null)"
  REVIEW_STATUS=$?
fi
END_SECONDS="$(date +%s)"
DURATION_MS=$(( (END_SECONDS - START_SECONDS) * 1000 ))

if [[ "$REVIEW_STATUS" -eq 124 ]]; then
  # A reviewer timeout/hang must NOT silently open the gate — otherwise a slow or
  # hung reviewer could bypass review entirely. The timeout path always fails
  # closed, regardless of the configured failClosed. If legitimate reviews need
  # more time, raise codexReview.preCommitHook.timeoutMs instead.
  fail_review "true" "review timed out after ${TIMEOUT_SECONDS}s" "$DURATION_MS" "hook_timeout"
fi
if [[ "$REVIEW_STATUS" -ne 0 ]]; then
  if [[ -n "$REVIEW_OUTPUT" ]] && jq -e . >/dev/null 2>&1 <<<"$REVIEW_OUTPUT"; then
    PARSE_ERROR_MESSAGE="$(review_parse_error_message "$REVIEW_OUTPUT")"
    if [[ -n "$PARSE_ERROR_MESSAGE" ]]; then
      fail_review "$FAIL_CLOSED" "review parseError: $PARSE_ERROR_MESSAGE" "$DURATION_MS"
    fi
  fi
  fail_review "$FAIL_CLOSED" "review command exited $REVIEW_STATUS" "$DURATION_MS"
fi
if [[ -z "$REVIEW_OUTPUT" ]]; then
  fail_review "$FAIL_CLOSED" "review returned empty output" "$DURATION_MS"
fi
if ! jq -e . >/dev/null 2>&1 <<<"$REVIEW_OUTPUT"; then
  fail_review "$FAIL_CLOSED" "review returned unparseable JSON" "$DURATION_MS"
fi
PARSE_ERROR_MESSAGE="$(review_parse_error_message "$REVIEW_OUTPUT")"
if [[ -n "$PARSE_ERROR_MESSAGE" ]]; then
  fail_review "$FAIL_CLOSED" "review parseError: $PARSE_ERROR_MESSAGE" "$DURATION_MS"
fi
NORMALIZED_REVIEW_OUTPUT="$(normalize_review_output "$REVIEW_OUTPUT" || true)"
if [[ -z "$NORMALIZED_REVIEW_OUTPUT" ]] || ! jq -e . >/dev/null 2>&1 <<<"$NORMALIZED_REVIEW_OUTPUT"; then
  fail_review "$FAIL_CLOSED" "review returned unparseable JSON" "$DURATION_MS"
fi

if [[ -n "$CACHE_FILE" && -n "$DIFF_HASH" ]]; then
  write_cache "$CACHE_FILE" "$DIFF_HASH" "$NORMALIZED_REVIEW_OUTPUT" "$DURATION_MS"
fi

evaluate_review_output "$NORMALIZED_REVIEW_OUTPUT" "sync" "$DURATION_MS"
