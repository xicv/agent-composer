#!/usr/bin/env bash
# Optional Codex warm-cache Stop hook.
# Fail-safe: every path exits 0 and never blocks session end.

set -u

RUN_LOG="/tmp/composer-codex-review-log.jsonl"

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

hash_stdin_16() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print substr($1,1,16)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print substr($1,1,16)}'
  else
    return 1
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

compute_diff_hash() {
  local root="$1"
  local pre_commit_command="$2"
  local scope="$3"
  local base="$4"
  local model="$5"
  local base_ref merge_base branch_diff
  # blockOnSeverity is excluded because threshold is re-applied at gate-read time from the cached findings array.
  {
    git -C "$root" diff HEAD 2>/dev/null
    git -C "$root" diff --cached 2>/dev/null
    if [[ "$scope" == "branch" ]]; then
      if base_ref="$(git -C "$root" rev-parse --verify "${base}^{commit}" 2>/dev/null)" \
        && merge_base="$(git -C "$root" merge-base "$base" HEAD 2>/dev/null)" \
        && branch_diff="$(git -C "$root" diff "$base...HEAD" 2>/dev/null)"; then
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
  git -C "$start" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null
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

if composer_disabled; then
  exit 0
fi

cat >/dev/null || true

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

CONFIG_PATH="${COMPOSER_CONFIG:-${CLAUDE_PROJECT_DIR:-.}/composer.config.json}"
[[ -f "$CONFIG_PATH" ]] || exit 0
CONFIG_JSON="$(cat "$CONFIG_PATH" 2>/dev/null || true)"
if [[ -z "$CONFIG_JSON" ]] || ! jq -e . >/dev/null 2>&1 <<<"$CONFIG_JSON"; then
  exit 0
fi

ENABLED="$(jq -r '.codexReview.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
PRECOMMIT_HOOK_ENABLED="$(jq -r '.codexReview.preCommitHook.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
WARM_CACHE_ENABLED="$(jq -r '.codexReview.warmCache.enabled // false' <<<"$CONFIG_JSON" 2>/dev/null || printf 'false')"
if [[ "$ENABLED" != "true" || "$PRECOMMIT_HOOK_ENABLED" != "true" || "$WARM_CACHE_ENABLED" != "true" ]]; then
  exit 0
fi

GIT_ROOT="$(find_git_root || true)"
[[ -n "$GIT_ROOT" ]] || exit 0
cd "$GIT_ROOT" 2>/dev/null || exit 0
[[ -n "$(git status --porcelain 2>/dev/null)" ]] || exit 0

REVIEW_COMMAND="$(jq -r '.codexReview.preCommitCommand // "review"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'review')"
SCOPE="$(jq -r '.codexReview.scope // "working-tree"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'working-tree')"
BASE="$(jq -r '.codexReview.base // "main"' <<<"$CONFIG_JSON" 2>/dev/null || printf 'main')"
CODEX_MODEL="$(jq -r '.codexReview.model // empty' <<<"$CONFIG_JSON" 2>/dev/null || true)"
TIMEOUT_MS="$(jq -r '.codexReview.warmCache.timeoutMs // 300000' <<<"$CONFIG_JSON" 2>/dev/null || printf '300000')"
WARM_CACHE_MAX_AGE_MINUTES="$(jq -r '.codexReview.warmCache.maxAgeMinutes // 30' <<<"$CONFIG_JSON" 2>/dev/null || printf '30')"
case "$REVIEW_COMMAND" in
  review|adversarial-review) ;;
  *) exit 0 ;;
esac
case "$TIMEOUT_MS" in
  ''|*[!0-9]*) TIMEOUT_MS=300000 ;;
esac
case "$WARM_CACHE_MAX_AGE_MINUTES" in
  ''|*[!0-9]*) WARM_CACHE_MAX_AGE_MINUTES=30 ;;
esac
TIMEOUT_SECONDS=$(( (TIMEOUT_MS + 999) / 1000 ))
if [[ "$TIMEOUT_SECONDS" -lt 1 ]]; then
  TIMEOUT_SECONDS=1
fi

DIFF_HASH="$(compute_diff_hash "$GIT_ROOT" "$REVIEW_COMMAND" "$SCOPE" "$BASE" "$CODEX_MODEL" 2>/dev/null || true)"
REPO_HASH="$(compute_repo_hash "$GIT_ROOT" 2>/dev/null || true)"
[[ -n "$DIFF_HASH" && -n "$REPO_HASH" ]] || exit 0

STATE_DIR="$(ensure_state_dir 2>/dev/null || true)"
[[ -n "$STATE_DIR" ]] || exit 0

CACHE_FILE="$STATE_DIR/codex-review-cache-${REPO_HASH}.json"
LOCK_FILE="$STATE_DIR/codex-warm-${REPO_HASH}.lock"
if cache_is_fresh_match "$CACHE_FILE" "$DIFF_HASH" "$WARM_CACHE_MAX_AGE_MINUTES"; then
  exit 0
fi
if [[ -f "$LOCK_FILE" ]]; then
  LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$LOCK_FILE" 2>/dev/null || true
fi

CODEX_ROOT="$(find_codex_plugin_root || true)"
[[ -n "$CODEX_ROOT" ]] || exit 0

spawn_warm_child() {
  local child_script
  child_script="$(mktemp "${TMPDIR:-/tmp}/composer-warm-child.XXXXXX" 2>/dev/null)" || return 0
  if ! cat > "$child_script" <<'COMPOSER_WARM_CHILD'
#!/usr/bin/env bash
set -u
codex_root="$1"
review_command="$2"
scope="$3"
base="$4"
timeout_seconds="$5"
cache_file="$6"
lock_file="$7"
diff_hash="$8"
run_log="$9"
review_model="${10}"

run_reviewer() {
  local timeout_seconds="$1"
  shift
  if [[ "${COMPOSER_FORCE_BASH_TIMEOUT:-}" != "1" ]] && command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" "$@"
    return $?
  fi
  if [[ "${COMPOSER_FORCE_BASH_TIMEOUT:-}" != "1" ]] && command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_seconds" "$@"
    return $?
  fi

  local pid watchdog status marker
  marker="${TMPDIR:-/tmp}/composer-timeout.$$.$RANDOM"
  "$@" &
  pid=$!
  (
    cleanup_sleeper() {
      if [[ -n "${sleeper:-}" ]]; then
        kill "$sleeper" 2>/dev/null || true
      fi
      exit 0
    }
    sleeper=""
    trap cleanup_sleeper TERM INT
    sleep "$timeout_seconds" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null || exit 0
    printf "1" >"$marker" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 5
    kill -KILL "$pid" 2>/dev/null || true
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

append_run_log() {
  local verdict="$1"
  local duration_ms="$2"
  local findings="$3"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg verdict "$verdict" \
    --arg source "warm" \
    --arg scope "$scope" \
    --arg diff_hash "$diff_hash" \
    --argjson duration_ms "${duration_ms:-0}" \
    --argjson findings "${findings:-0}" \
    "{ts:\$ts,verdict:\$verdict,decision:\"skip\",source:\$source,duration_ms:\$duration_ms,findings:\$findings,scope:\$scope,diff_hash:\$diff_hash}" \
    >> "$run_log" 2>/dev/null || true
}

cleanup() {
  local lock_owner
  lock_owner="$(head -n 1 "$lock_file" 2>/dev/null || true)"
  if [[ "$lock_owner" == "$$" ]]; then
    rm -f "$lock_file" 2>/dev/null || true
  fi
  rm -f "$0" 2>/dev/null || true
}
trap cleanup EXIT
printf "%s\n" "$$" > "$lock_file" 2>/dev/null || true

args=("node" "$codex_root/scripts/codex-companion.mjs" "$review_command" "--wait" "--json" "--scope" "$scope")
if [[ "$scope" == "branch" ]]; then
  args+=("--base" "$base")
fi
if [[ -n "$review_model" ]]; then
  args+=("--model" "$review_model")
fi
start_seconds="$(date +%s)"
output="$(run_reviewer "$timeout_seconds" "${args[@]}" 2>/dev/null)"
status=$?
end_seconds="$(date +%s)"
duration_ms=$(( (end_seconds - start_seconds) * 1000 ))
if [[ "$status" -ne 0 || -z "$output" ]] || ! jq -e . >/dev/null 2>&1 <<<"$output"; then
  append_run_log "skip" "$duration_ms" 0
  exit 0
fi
parse_error_message="$(jq -r '
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
' <<<"$output" 2>/dev/null || true)"
if [[ -n "$parse_error_message" ]]; then
  append_run_log "skip" "$duration_ms" 0
  exit 0
fi
normalized="$(jq -c '
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
' <<<"$output" 2>/dev/null || true)"
if [[ -z "$normalized" ]] || ! jq -e . >/dev/null 2>&1 <<<"$normalized"; then
  append_run_log "skip" "$duration_ms" 0
  exit 0
fi
findings="$(jq -r "if (.findings | type) == \"array\" then (.findings | length) else 0 end" <<<"$normalized" 2>/dev/null || printf "0")"
verdict="$(jq -r ".verdict // \"skip\"" <<<"$normalized" 2>/dev/null || printf "skip")"
case "$verdict" in
  approve|needs-attention)
    tmp="${cache_file}.$$"
    jq -nc \
      --arg hash "$diff_hash" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson review "$normalized" \
      --argjson durationMs "$duration_ms" \
      "{hash:\$hash, verdict:(\$review.verdict // \"error\"), summary:(\$review.summary // \"\"), findings:(if (\$review.findings | type) == \"array\" then \$review.findings else [] end), ts:\$ts, durationMs:\$durationMs}" \
      > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null && mv "$tmp" "$cache_file" 2>/dev/null || rm -f "$tmp"
    ;;
esac
append_run_log "$verdict" "$duration_ms" "$findings"
COMPOSER_WARM_CHILD
  then
    rm -f "$child_script" 2>/dev/null || true
    return 0
  fi
  chmod +x "$child_script" 2>/dev/null || true
  if ! printf "%s\n" "$$" > "$LOCK_FILE" 2>/dev/null; then
    rm -f "$child_script" 2>/dev/null || true
    return 0
  fi
  nohup bash "$child_script" "$CODEX_ROOT" "$REVIEW_COMMAND" "$SCOPE" "$BASE" "$TIMEOUT_SECONDS" "$CACHE_FILE" "$LOCK_FILE" "$DIFF_HASH" "$RUN_LOG" "$CODEX_MODEL" >/dev/null 2>&1 &
  local bg_pid=$!
  if [[ -z "${bg_pid:-}" ]]; then
    local lock_owner
    lock_owner="$(head -n 1 "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$lock_owner" == "$$" ]]; then
      rm -f "$LOCK_FILE" 2>/dev/null || true
    fi
    rm -f "$child_script" 2>/dev/null || true
    return 0
  fi
  disown "$bg_pid" 2>/dev/null || true
  return 0
}

spawn_warm_child || true

exit 0
