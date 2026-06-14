#!/usr/bin/env bash
# Wave 3 Step 1 — harness for scripts/evolve_check_diff.sh.
# Contract: PR-gate for autoresearch diff scope.
#   exit 0 — every supplied path matches whitelist
#   exit 1 — at least one path outside whitelist
#   exit 2 — usage error

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CHECK="${EVOLVE_CHECK:-$REPO_ROOT/scripts/evolve_check_diff.sh}"

if [[ ! -x "$CHECK" ]]; then
  echo "FAIL: evolve_check_diff.sh missing or not executable at $CHECK" >&2
  echo "      (expected during RED before Step 1 GREEN2)" >&2
  exit 1
fi

PASS=0; FAIL=0
declare -a FAILED

run_expect() {
  local want="$1" name="$2"; shift 2
  local out status
  out="$("$CHECK" "$@" 2>&1 || true)"
  status=$?
  # Re-run to capture the real exit code (above swallowed it via || true)
  "$CHECK" "$@" >/dev/null 2>&1 || status=$?
  if [[ "$status" == "$want" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-45s exit=%s\n' "$name" "$status"
  else
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected exit $want, got $status")
    printf '  FAIL  %-45s want %s, got %s\n' "$name" "$want" "$status"
  fi
}

echo "=== evolve_check_diff.sh fixture harness ==="
run_expect 0 "allow_agent_md"             ".claude/agents/coder.md"
run_expect 0 "allow_skill_md"             ".claude/skills/composer-mastermind/SKILL.md"
run_expect 0 "allow_eval_task_json"       "evals/tasks/t99-foo.json"
run_expect 0 "allow_tasks_jsonl"          "evals/tasks.jsonl"
run_expect 0 "allow_multi_whitelisted"    ".claude/agents/coder.md" "evals/tasks.jsonl"
run_expect 1 "deny_src_providers"         "src/providers/AnthropicCompatibleProvider.ts"
run_expect 1 "deny_env_json"              ".env.json"
run_expect 1 "deny_boundary_guard"        "scripts/boundary_guard.sh"
run_expect 1 "deny_adr"                   "docs/adr/0001-contracts.md"
run_expect 1 "deny_mixed_allow_block"     ".claude/agents/coder.md" "src/index.ts"
run_expect 1 "deny_nested_agent"          ".claude/agents/sub/foo.md"
run_expect 1 "deny_skill_other"           ".claude/skills/other-skill/SKILL.md"
run_expect 1 "deny_nested_task"           "evals/tasks/sub/foo.json"
run_expect 2 "usage_error_no_args"

echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  echo; echo "Failures:"; printf '  - %s\n' "${FAILED[@]}"; exit 1
fi

echo
echo "=== precommit_codex_review.sh warm-cache helpers ==="

GUARD="${PRECOMMIT_GUARD:-$REPO_ROOT/scripts/precommit_codex_review.sh}"
if [[ ! -x "$GUARD" ]]; then
  FAIL=$((FAIL+1))
  FAILED+=("precommit_codex_review.sh missing or not executable at $GUARD")
  printf '  FAIL  %-45s missing executable\n' "precommit_guard_exists"
else
  TMP="$(mktemp -d -t composer_precommit_helpers.XXXXXX)"
  trap 'rm -rf "$TMP"' EXIT
  REPO="$TMP/repo"
  CACHE_FILE="$TMP/cache.json"

  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email composer@example.test
  git -C "$REPO" config user.name Composer
  printf 'base\n' > "$REPO/a.txt"
  git -C "$REPO" add a.txt
  git -C "$REPO" commit -q -m init
  printf 'first\n' >> "$REPO/a.txt"
  git -C "$REPO" add a.txt

  LIB_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m smoke"}}'
  if COMPOSER_PRECOMMIT_LIB_ONLY=1 source "$GUARD" <<<"$LIB_PAYLOAD"; then
    PASS=$((PASS+1))
    printf '  ok    %-45s SOURCE\n' "precommit_guard_library_mode"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_guard_library_mode: expected source to return successfully")
    printf '  FAIL  %-45s expected SOURCE\n' "precommit_guard_library_mode"
  fi

  REPO_REAL="$(cd "$REPO" && pwd -P)"
  HASH_A="$(compute_diff_hash "$REPO_REAL" "review" "working-tree" "main" "gpt-5.4-mini")"
  HASH_B="$(compute_diff_hash "$REPO_REAL" "review" "working-tree" "main" "gpt-5.4-mini")"
  printf 'second\n' >> "$REPO/a.txt"
  git -C "$REPO" add a.txt
  HASH_C="$(compute_diff_hash "$REPO_REAL" "review" "working-tree" "main" "gpt-5.4-mini")"

  if [[ -n "$HASH_A" && "$HASH_A" == "$HASH_B" && "$HASH_A" != "$HASH_C" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-45s HASH\n' "precommit_diff_hash_deterministic_changes"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_diff_hash_deterministic_changes: expected same hash for same diff and different hash after staged diff changed; first=${HASH_A:-<empty>} second=${HASH_B:-<empty>} third=${HASH_C:-<empty>}")
    printf '  FAIL  %-45s expected HASH\n' "precommit_diff_hash_deterministic_changes"
  fi

  cat >"$CACHE_FILE" <<JSON
{"hash":"$HASH_C","verdict":"approve","summary":"ok","findings":[],"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationMs":10}
JSON
  if cache_is_fresh_match "$CACHE_FILE" "$HASH_C" 30; then
    PASS=$((PASS+1))
    printf '  ok    %-45s FRESH\n' "precommit_cache_fresh_hash_match"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_cache_fresh_hash_match: expected fresh matching cache to pass")
    printf '  FAIL  %-45s expected FRESH\n' "precommit_cache_fresh_hash_match"
  fi

  cat >"$CACHE_FILE" <<JSON
{"hash":"$HASH_C","verdict":"approve","summary":"old","findings":[],"ts":"2000-01-01T00:00:00Z","durationMs":10}
JSON
  if ! cache_is_fresh_match "$CACHE_FILE" "$HASH_C" 30; then
    PASS=$((PASS+1))
    printf '  ok    %-45s STALE\n' "precommit_cache_stale_rejected"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_cache_stale_rejected: expected stale cache to fail freshness check")
    printf '  FAIL  %-45s expected STALE\n' "precommit_cache_stale_rejected"
  fi

  cat >"$CACHE_FILE" <<JSON
{"hash":"not-$HASH_C","verdict":"approve","summary":"wrong","findings":[],"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationMs":10}
JSON
  if ! cache_is_fresh_match "$CACHE_FILE" "$HASH_C" 30; then
    PASS=$((PASS+1))
    printf '  ok    %-45s MISS\n' "precommit_cache_hash_mismatch_rejected"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_cache_hash_mismatch_rejected: expected mismatched hash to fail freshness check")
    printf '  FAIL  %-45s expected MISS\n' "precommit_cache_hash_mismatch_rejected"
  fi

  rm -f "$CACHE_FILE"
  write_cache "$CACHE_FILE" "$HASH_C" '{"verdict":"approve","summary":"ok","findings":[]}' 10
  if [[ -f "$CACHE_FILE" ]] && jq -e '.verdict == "approve" and .hash == "'"$HASH_C"'"' "$CACHE_FILE" >/dev/null 2>&1; then
    PASS=$((PASS+1))
    printf '  ok    %-45s WRITE\n' "precommit_write_cache_approve"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_write_cache_approve: expected approve verdict to be written")
    printf '  FAIL  %-45s expected WRITE\n' "precommit_write_cache_approve"
  fi

  rm -f "$CACHE_FILE"
  write_cache "$CACHE_FILE" "$HASH_C" '{"verdict":"needs-attention","summary":"review","findings":[]}' 10
  if [[ -f "$CACHE_FILE" ]] && jq -e '.verdict == "needs-attention" and .hash == "'"$HASH_C"'"' "$CACHE_FILE" >/dev/null 2>&1; then
    PASS=$((PASS+1))
    printf '  ok    %-45s WRITE\n' "precommit_write_cache_needs_attention"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_write_cache_needs_attention: expected needs-attention verdict to be written")
    printf '  FAIL  %-45s expected WRITE\n' "precommit_write_cache_needs_attention"
  fi

  rm -f "$CACHE_FILE"
  write_cache "$CACHE_FILE" "$HASH_C" '{"verdict":"blocked","summary":"no","findings":[]}' 10
  if [[ ! -f "$CACHE_FILE" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-45s SKIP\n' "precommit_write_cache_blocked_skipped"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_write_cache_blocked_skipped: expected blocked verdict not to write cache")
    printf '  FAIL  %-45s expected SKIP\n' "precommit_write_cache_blocked_skipped"
  fi

  rm -f "$CACHE_FILE"
  write_cache "$CACHE_FILE" "$HASH_C" '{"verdict":"garbage","summary":"no","findings":[]}' 10
  if [[ ! -f "$CACHE_FILE" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-45s SKIP\n' "precommit_write_cache_other_skipped"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_write_cache_other_skipped: expected unknown verdict not to write cache")
    printf '  FAIL  %-45s expected SKIP\n' "precommit_write_cache_other_skipped"
  fi
fi

echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  echo; echo "Failures:"; printf '  - %s\n' "${FAILED[@]}"; exit 1
fi
