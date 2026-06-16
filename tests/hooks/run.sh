#!/usr/bin/env bash
# Wave 1 F1.9 — assertion harness for scripts/boundary_guard.sh.
# Pipes each fixture (or special inline payload) to the script and asserts
# the JSON response carries the expected permissionDecision.
#
# Contract per docs/adr/0001-contracts.md C0.4:
#   - exit code 0 always (semantics carried by JSON on stdout)
#   - deny  → JSON contains "permissionDecision":"deny"
#   - allow → no deny JSON emitted (script may emit nothing or pass-through)
#   - malformed / empty stdin / missing tool_name → fail closed (deny)

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="${BOUNDARY_GUARD:-$REPO_ROOT/scripts/boundary_guard.sh}"

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: boundary_guard.sh missing or not executable at $SCRIPT" >&2
  echo "      (this is expected during RED phase before F1.5 is implemented)" >&2
  exit 1
fi

PASS=0
FAIL=0
declare -a FAILED

is_deny() {
  grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'
}

assert_deny_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$SCRIPT" 2>&1)"
  if is_deny <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s DENY\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected DENY, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected DENY\n' "$name"
  fi
}

assert_pass_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$SCRIPT" 2>&1)"
  if is_deny <<<"$out"; then
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected PASS, got DENY: $out")
    printf '  FAIL  %-40s expected PASS\n' "$name"
  else
    PASS=$((PASS+1))
    printf '  ok    %-40s PASS\n' "$name"
  fi
}

assert_deny_fixture() {
  assert_deny_payload "$1" "$(cat "$HERE/$2")"
}
assert_pass_fixture() {
  assert_pass_payload "$1" "$(cat "$HERE/$2")"
}

echo "=== boundary_guard.sh fixture harness ==="

# Native Bash is allowed for main-thread inspection and verification.
assert_pass_fixture "allow_bash"          "01_allow_bash.json"

# Block list — native file-mutating tools
assert_deny_fixture "block_edit"          "02_block_edit.json"
assert_deny_fixture "block_write"         "03_block_write.json"
assert_deny_fixture "block_notebook_edit" "04_block_notebook_edit.json"
assert_deny_fixture "block_update"        "17_block_update.json"

# Block list — MCP-prefixed variants
assert_deny_fixture "block_mcp_write"     "05_block_mcp_write.json"
assert_deny_fixture "block_mcp_edit"      "06_block_mcp_edit.json"
assert_deny_fixture "block_mcp_bash"      "07_block_mcp_bash.json"

# Allow list — Claude built-ins
assert_pass_fixture "allow_read"          "08_allow_read.json"
assert_pass_fixture "allow_grep"          "09_allow_grep.json"
assert_pass_fixture "allow_glob"          "10_allow_glob.json"
assert_pass_fixture "allow_task"          "11_allow_task.json"

# Allow list — composer MCP tools (C0.3)
assert_pass_fixture "allow_mcp_research"  "12_allow_mcp_research.json"
assert_pass_fixture "allow_mcp_code"      "13_allow_mcp_code.json"
assert_pass_fixture "allow_mcp_review"    "14_allow_mcp_review.json"
assert_pass_fixture "allow_mcp_handoff"   "16_allow_mcp_handoff.json"

# Malformed / failure modes — must fail closed
assert_deny_fixture "malformed_missing_tool_name" "15_malformed_missing_tool_name.json"
assert_deny_payload "malformed_not_json"          "this-is-not-json{"
assert_deny_payload "empty_stdin"                 ""

# STOP_EVOLVE sentinel behavior (Wave 3 Step 1)
STOP_TMP="$(mktemp -t composer_stop.XXXXXX)"
export COMPOSER_STOP_EVOLVE_FILE="$STOP_TMP"
assert_deny_payload "stop_evolve_blocks_mcp_research" \
  '{"hook_event_name":"PreToolUse","tool_name":"mcp__composer__composer_research","tool_input":{"prompt":"x"},"session_id":"t"}'
assert_pass_payload "stop_evolve_does_not_block_read" \
  '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"x"},"session_id":"t"}'
assert_pass_payload "stop_evolve_does_not_block_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"t"}'
rm -f "$STOP_TMP"
assert_pass_payload "no_stop_evolve_allows_mcp_research" \
  '{"hook_event_name":"PreToolUse","tool_name":"mcp__composer__composer_research","tool_input":{"prompt":"x"},"session_id":"t"}'
unset COMPOSER_STOP_EVOLVE_FILE

# Subagent tool calls must be allowed so coder can apply and verify patches.
assert_pass_payload "subagent_agent_name_allows_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","agent_name":"coder","tool_input":{"command":"npm run typecheck"},"session_id":"t"}'
assert_pass_payload "subagent_transcript_allows_update" \
  '{"hook_event_name":"PreToolUse","tool_name":"Update","transcript_path":"/tmp/claude/subagents/coder/transcript.jsonl","tool_input":{"file_path":"x","old_string":"a","new_string":"b"},"session_id":"t"}'

# Path-scoped boundary (fail-safe canonicalization). REPO_ROOT IS the composer repo.
assert_deny_payload "block_edit_inside_repo_abs" \
  "$(jq -nc --arg f "$REPO_ROOT/src/index.ts" '{hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:$f,old_string:"a",new_string:"b"},session_id:"t"}')"
assert_deny_payload "block_edit_inside_repo_dotdot" \
  "$(jq -nc --arg f "$REPO_ROOT/scripts/../src/index.ts" '{hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:$f,old_string:"a",new_string:"b"},session_id:"t"}')"
assert_pass_payload "allow_edit_outside_repo_abs" \
  '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/tmp/composer-not-a-repo-file.ts","old_string":"a","new_string":"b"},"session_id":"t"}'
# New-directory cases (canonicalizer walks to nearest existing ancestor).
# Outside-repo write into a not-yet-existing dir must be ALLOWED (this is
# the false-deny that the nearest-ancestor fix removes).
assert_pass_payload "allow_edit_outside_repo_new_dir" \
  '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/tmp/composer-not-a-repo-NEWDIR/sub/deep/new.md","content":"x"},"session_id":"t"}'
# In-repo write into a not-yet-existing dir must STILL be DENIED.
assert_deny_payload "block_edit_inside_repo_new_dir" \
  "$(jq -nc --arg f "$REPO_ROOT/this-dir-does-not-exist-yet/sub/new.ts" '{hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{file_path:$f,content:"x"},session_id:"t"}')"
# Fail-open regression: invoked from a SUBDIR (CLAUDE_PROJECT_DIR points at a
# subdir of the repo) editing a repo file ABOVE that subdir must still DENY.
SUBDIR_PAYLOAD="$(jq -nc --arg f "$REPO_ROOT/src/index.ts" '{hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:$f,old_string:"a",new_string:"b"},session_id:"t"}')"
SUBDIR_OUT="$(printf '%s' "$SUBDIR_PAYLOAD" | CLAUDE_PROJECT_DIR="$REPO_ROOT/scripts" "$SCRIPT" 2>&1)"
if is_deny <<<"$SUBDIR_OUT"; then
  PASS=$((PASS+1)); printf '  ok    %-40s DENY\n' "block_edit_subdir_project_dir"
else
  FAIL=$((FAIL+1)); FAILED+=("block_edit_subdir_project_dir: expected DENY, got: ${SUBDIR_OUT:-<empty>}"); printf '  FAIL  %-40s expected DENY\n' "block_edit_subdir_project_dir"
fi

# COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS (Wave 3 Step 1)
export COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS=true
assert_pass_payload "bypass_allows_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"t"}'
assert_pass_payload "bypass_allows_edit" \
  '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"x","old_string":"a","new_string":"b"},"session_id":"t"}'
assert_pass_payload "bypass_allows_write" \
  '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"x","content":"y"},"session_id":"t"}'
unset COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS
assert_pass_payload "no_bypass_allows_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"t"}'

# Soft disable toggle for normal daily use.
export COMPOSER_ENABLED=0
assert_pass_payload "composer_enabled_zero_allows_edit" \
  '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"x","old_string":"a","new_string":"b"},"session_id":"t"}'
unset COMPOSER_ENABLED
DISABLED_TMP="$(mktemp -t composer_disabled.XXXXXX)"
export COMPOSER_DISABLED_FILE="$DISABLED_TMP"
assert_pass_payload "composer_disabled_file_allows_write" \
  '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"x","content":"y"},"session_id":"t"}'
rm -f "$DISABLED_TMP"
unset COMPOSER_DISABLED_FILE

echo
echo "=== precommit_codex_review.sh fixture harness ==="

GUARD2="${PRECOMMIT_GUARD:-$REPO_ROOT/scripts/precommit_codex_review.sh}"
if [[ ! -x "$GUARD2" ]]; then
  FAIL=$((FAIL+1))
  FAILED+=("precommit_codex_review.sh missing or not executable at $GUARD2")
  printf '  FAIL  %-40s missing executable\n' "precommit_guard_exists"
else
  printf '  ok    %-40s executable\n' "precommit_guard_exists"

  PRECOMMIT_TMP="$(mktemp -d -t composer_precommit.XXXXXX)"
  trap 'rm -rf "$PRECOMMIT_TMP"' EXIT

  REVIEW_APPROVE="$PRECOMMIT_TMP/review-approve.sh"
  REVIEW_HIGH="$PRECOMMIT_TMP/review-high.sh"
  REVIEW_LOW="$PRECOMMIT_TMP/review-low.sh"
  REVIEW_FAIL="$PRECOMMIT_TMP/review-fail.sh"
  REVIEW_EXIT_PARSE_ERROR="$PRECOMMIT_TMP/review-exit-parse-error.sh"
  REVIEW_PARSE_ERROR="$PRECOMMIT_TMP/review-parse-error.sh"
  REVIEW_GARBAGE="$PRECOMMIT_TMP/review-garbage.sh"
  REVIEW_NESTED_HIGH="$PRECOMMIT_TMP/review-nested-high.sh"
  REVIEW_CODEX_STDOUT_HIGH="$PRECOMMIT_TMP/review-codex-stdout-high.sh"
  REVIEW_NATIVE_TEXT="$PRECOMMIT_TMP/review-native-text.sh"
  CONFIG_ENABLED="$PRECOMMIT_TMP/enabled.json"
  CONFIG_DISABLED="$PRECOMMIT_TMP/disabled.json"
  CONFIG_FAIL_CLOSED="$PRECOMMIT_TMP/fail-closed.json"
  CONFIG_TIMEOUT="$PRECOMMIT_TMP/timeout.json"
  CONFIG_WARM="$PRECOMMIT_TMP/warm.json"
  CONFIG_WARM_PRECOMMIT_DISABLED="$PRECOMMIT_TMP/warm-precommit-disabled.json"
  CONFIG_WARM_MODEL_A="$PRECOMMIT_TMP/warm-model-a.json"
  CONFIG_WARM_MODEL_B="$PRECOMMIT_TMP/warm-model-b.json"
  CONFIG_GPT_PRO="$PRECOMMIT_TMP/gpt-pro.json"
  CONFIG_WARM_DISABLED="$PRECOMMIT_TMP/warm-disabled.json"
  CONFIG_BRANCH_WARM="$PRECOMMIT_TMP/branch-warm.json"
  PRECOMMIT_GIT_ROOT="$PRECOMMIT_TMP/repo"
  PRECOMMIT_STATE_DIR="$PRECOMMIT_TMP/state"

  cat >"$REVIEW_APPROVE" <<'SH'
#!/usr/bin/env bash
if [[ -n "${PRECOMMIT_SYNC_MARKER:-}" ]]; then
  : > "$PRECOMMIT_SYNC_MARKER"
fi
printf '%s\n' '{"result":{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]},"parseError":null}'
SH
  cat >"$REVIEW_HIGH" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"verdict":"needs-attention","summary":"bug","findings":[{"severity":"high","title":"X","body":"b","file":"a.ts","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"fix"}],"next_steps":[]}'
SH
  cat >"$REVIEW_LOW" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"verdict":"needs-attention","summary":"bug","findings":[{"severity":"low","title":"X","body":"b","file":"a.ts","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"fix"}],"next_steps":[]}'
SH
  cat >"$REVIEW_FAIL" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  cat >"$REVIEW_EXIT_PARSE_ERROR" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"review":"Adversarial Review","result":null,"parseError":"usage limit reached"}'
exit 1
SH
  cat >"$REVIEW_PARSE_ERROR" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"review":"free text","parseError":"could not parse structured review","result":null}'
SH
  cat >"$REVIEW_GARBAGE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"verdict":"garbage","summary":"bad","findings":[],"next_steps":[]}'
SH
  cat >"$REVIEW_NESTED_HIGH" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"data":{"result":{"verdict":"needs-attention","summary":"nested bug","findings":[{"severity":"high","title":"Nested","body":"b","file":"a.ts","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"fix"}],"next_steps":[]}},"parseError":null}'
SH
  cat >"$REVIEW_CODEX_STDOUT_HIGH" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"review":"Adversarial Review","codex":{"status":0,"stdout":"{\"verdict\":\"needs-attention\",\"summary\":\"stdout bug\",\"findings\":[{\"severity\":\"high\",\"title\":\"Stdout\",\"body\":\"b\",\"file\":\"a.ts\",\"line_start\":1,\"line_end\":1,\"confidence\":0.9,\"recommendation\":\"fix\"}],\"next_steps\":[]}"}}'
SH
  cat >"$REVIEW_NATIVE_TEXT" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"review":"Review","codex":{"status":0,"stdout":"Found one issue in the reviewed diff, but this native review output is not structured JSON."}}'
SH
  chmod +x "$REVIEW_APPROVE" "$REVIEW_HIGH" "$REVIEW_LOW" "$REVIEW_FAIL" "$REVIEW_EXIT_PARSE_ERROR" "$REVIEW_PARSE_ERROR" "$REVIEW_GARBAGE" "$REVIEW_NESTED_HIGH" "$REVIEW_CODEX_STDOUT_HIGH" "$REVIEW_NATIVE_TEXT"

  cat >"$CONFIG_ENABLED" <<'JSON'
{"codexReview":{"enabled":true,"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_DISABLED" <<'JSON'
{"codexReview":{"enabled":false,"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_FAIL_CLOSED" <<'JSON'
{"codexReview":{"enabled":true,"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":true}}}
JSON
  cat >"$CONFIG_TIMEOUT" <<'JSON'
{"codexReview":{"enabled":true,"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false,"timeoutMs":2000}}}
JSON
  cat >"$CONFIG_WARM" <<'JSON'
{"codexReview":{"enabled":true,"scope":"working-tree","warmCache":{"enabled":true,"maxAgeMinutes":30,"timeoutMs":300000},"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_WARM_PRECOMMIT_DISABLED" <<'JSON'
{"codexReview":{"enabled":true,"scope":"working-tree","warmCache":{"enabled":true,"maxAgeMinutes":30,"timeoutMs":300000},"preCommitHook":{"enabled":false,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_WARM_MODEL_A" <<'JSON'
{"codexReview":{"enabled":true,"scope":"working-tree","base":"main","model":"model-a","warmCache":{"enabled":true,"maxAgeMinutes":30,"timeoutMs":300000},"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_WARM_MODEL_B" <<'JSON'
{"codexReview":{"enabled":true,"scope":"working-tree","base":"main","model":"model-b","warmCache":{"enabled":true,"maxAgeMinutes":30,"timeoutMs":300000},"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_GPT_PRO" <<'JSON'
{"codexReview":{"enabled":true,"scope":"working-tree","base":"main","model":"gpt-5.5-pro","preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":true}}}
JSON
  cat >"$CONFIG_WARM_DISABLED" <<'JSON'
{"codexReview":{"enabled":true,"warmCache":{"enabled":false},"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON
  cat >"$CONFIG_BRANCH_WARM" <<'JSON'
{"codexReview":{"enabled":true,"scope":"branch","base":"main","warmCache":{"enabled":true,"maxAgeMinutes":30,"timeoutMs":300000},"preCommitHook":{"enabled":true,"blockOnSeverity":"high","failClosed":false}}}
JSON

  mkdir -p "$PRECOMMIT_GIT_ROOT"
  PRECOMMIT_GIT_ROOT="$(cd "$PRECOMMIT_GIT_ROOT" && pwd -P)"
  git -C "$PRECOMMIT_GIT_ROOT" init -q
  git -C "$PRECOMMIT_GIT_ROOT" config user.email composer@example.test
  git -C "$PRECOMMIT_GIT_ROOT" config user.name Composer
  printf 'base\n' > "$PRECOMMIT_GIT_ROOT/a.txt"
  git -C "$PRECOMMIT_GIT_ROOT" add a.txt
  git -C "$PRECOMMIT_GIT_ROOT" commit -q -m init
  printf 'dirty\n' >> "$PRECOMMIT_GIT_ROOT/a.txt"
  mkdir -p "$PRECOMMIT_STATE_DIR"
  chmod 700 "$PRECOMMIT_STATE_DIR"

  run_precommit_hook() {
    local payload="$1" config="$2" reviewer="$3" disabled="${4:-}" out
    out="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$config" COMPOSER_CODEX_REVIEW_CMD="$reviewer" COMPOSER_DISABLED="$disabled" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$GUARD2" 2>/dev/null)"
    printf '%s' "$out"
  }

  run_precommit_hook_plugin() {
    local payload="$1" config="$2" plugin_root="$3" disabled="${4:-}" out
    out="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$config" COMPOSER_CODEX_PLUGIN_ROOT="$plugin_root" COMPOSER_DISABLED="$disabled" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$GUARD2" 2>/dev/null)"
    printf '%s' "$out"
  }

  test_hash_string() {
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 | awk '{print substr($1,1,16)}'
    else
      sha256sum | awk '{print substr($1,1,16)}'
    fi
  }

  test_repo_hash() {
    printf '%s' "$PRECOMMIT_GIT_ROOT" | test_hash_string
  }

  test_diff_hash() {
    local config="$1"
    local review_command scope base model base_ref merge_base branch_diff
    review_command="$(jq -r '.codexReview.preCommitCommand // "review"' "$config")"
    scope="$(jq -r '.codexReview.scope // "working-tree"' "$config")"
    base="$(jq -r '.codexReview.base // "main"' "$config")"
    model="$(jq -r '.codexReview.model // empty' "$config")"
    {
      git -C "$PRECOMMIT_GIT_ROOT" diff HEAD 2>/dev/null
      git -C "$PRECOMMIT_GIT_ROOT" diff --cached 2>/dev/null
      if [[ "$scope" == "branch" ]]; then
        if base_ref="$(git -C "$PRECOMMIT_GIT_ROOT" rev-parse --verify "${base}^{commit}" 2>/dev/null)" \
          && merge_base="$(git -C "$PRECOMMIT_GIT_ROOT" merge-base "$base" HEAD 2>/dev/null)" \
          && branch_diff="$(git -C "$PRECOMMIT_GIT_ROOT" diff "$base...HEAD" 2>/dev/null)"; then
          printf '\ncomposer-codex-review-branch\nbaseRef=%s\nmergeBase=%s\n' "$base_ref" "$merge_base"
          printf '%s' "$branch_diff"
          printf '\n'
        fi
      fi
      printf '\ncomposer-codex-review-policy\npreCommitCommand=%s\nscope=%s\nbase=%s\nmodel=%s\n' "$review_command" "$scope" "$base" "$model"
    } | test_hash_string
  }

  assert_precommit_deny_payload() {
    local name="$1" payload="$2" config="$3" reviewer="$4" disabled="${5:-}" out
    out="$(run_precommit_hook "$payload" "$config" "$reviewer" "$disabled")"
    if is_deny <<<"$out"; then
      PASS=$((PASS+1))
      printf '  ok    %-40s DENY\n' "$name"
    else
      FAIL=$((FAIL+1))
      FAILED+=("$name: expected DENY, got: ${out:-<empty>}")
      printf '  FAIL  %-40s expected DENY\n' "$name"
    fi
  }

  assert_precommit_pass_payload() {
    local name="$1" payload="$2" config="$3" reviewer="$4" disabled="${5:-}" out
    out="$(run_precommit_hook "$payload" "$config" "$reviewer" "$disabled")"
    if is_deny <<<"$out"; then
      FAIL=$((FAIL+1))
      FAILED+=("$name: expected PASS, got DENY: $out")
      printf '  FAIL  %-40s expected PASS\n' "$name"
    else
      PASS=$((PASS+1))
      printf '  ok    %-40s PASS\n' "$name"
    fi
  }

  assert_precommit_system_message() {
    local name="$1" payload="$2" config="$3" reviewer="$4" needle="$5" out
    out="$(run_precommit_hook "$payload" "$config" "$reviewer")"
    if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "$needle" <<<"$out"; then
      PASS=$((PASS+1))
      printf '  ok    %-40s SYSTEM\n' "$name"
    else
      FAIL=$((FAIL+1))
      FAILED+=("$name: expected systemMessage containing $needle, got: ${out:-<empty>}")
      printf '  FAIL  %-40s expected SYSTEM\n' "$name"
    fi
  }

  assert_precommit_bash_watchdog_timeout() {
    local name="$1" payload="$2" config="$3" start end elapsed out log_file
    log_file="$PRECOMMIT_TMP/${name}.jsonl"
    start="$(date +%s)"
    out="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$config" COMPOSER_CODEX_REVIEW_CMD="sleep 30" COMPOSER_FORCE_BASH_TIMEOUT=1 RUN_LOG="$log_file" "$GUARD2" 2>/dev/null)"
    end="$(date +%s)"
    elapsed=$((end - start))
    if is_deny <<<"$out" && grep -Fq "timed out" <<<"$out" && [[ "$elapsed" -le 10 ]] \
       && jq -e 'select(.reason_code == "hook_timeout" and .stage == "precommit_codex_review" and (.elapsed_wall_ms | type) == "number")' "$log_file" >/dev/null 2>&1; then
      PASS=$((PASS+1))
      printf '  ok    %-40s WATCHDOG\n' "$name"
    else
      FAIL=$((FAIL+1))
      FAILED+=("$name: expected timeout DENY with hook_timeout log within 10s, elapsed=${elapsed}s, got: ${out:-<empty>}")
      printf '  FAIL  %-40s expected WATCHDOG\n' "$name"
    fi
  }

  PAYLOAD_EDIT='{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"a.ts","old_string":"a","new_string":"b"}}'
  PAYLOAD_STATUS='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}'
  PAYLOAD_COMMIT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}'
  PAYLOAD_DRY_RUN='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit --dry-run"}}'

  assert_precommit_pass_payload "precommit_non_bash_allows" "$PAYLOAD_EDIT" "$CONFIG_ENABLED" "$REVIEW_HIGH"
  assert_precommit_pass_payload "precommit_non_commit_allows" "$PAYLOAD_STATUS" "$CONFIG_ENABLED" "$REVIEW_HIGH"
  assert_precommit_pass_payload "precommit_gate_disabled_allows" "$PAYLOAD_COMMIT" "$CONFIG_DISABLED" "$REVIEW_HIGH"
  assert_precommit_pass_payload "precommit_approve_allows" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_APPROVE"
  assert_precommit_system_message "precommit_approve_system_message" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_APPROVE" "approve"
  assert_precommit_deny_payload "precommit_high_denies" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_HIGH"
  assert_precommit_pass_payload "precommit_low_below_threshold_allows" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_LOW"
  assert_precommit_pass_payload "precommit_dry_run_allows" "$PAYLOAD_DRY_RUN" "$CONFIG_ENABLED" "$REVIEW_HIGH"
  assert_precommit_pass_payload "precommit_composer_disabled_allows" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_HIGH" "1"
  out="$(run_precommit_hook "$PAYLOAD_COMMIT" "$CONFIG_GPT_PRO" "$REVIEW_APPROVE")"
  if is_deny <<<"$out" && grep -Fq "ChatGPT-Pro/Oracle browser lane" <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s DENY\n' "precommit_gpt_pro_model_denies"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_gpt_pro_model_denies: expected gpt-5.5-pro deny, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected DENY\n' "precommit_gpt_pro_model_denies"
  fi
  assert_precommit_pass_payload "precommit_reviewer_fail_open_allows" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_FAIL"
  assert_precommit_deny_payload "precommit_reviewer_fail_closed_denies" "$PAYLOAD_COMMIT" "$CONFIG_FAIL_CLOSED" "$REVIEW_FAIL"
  out="$(run_precommit_hook "$PAYLOAD_COMMIT" "$CONFIG_FAIL_CLOSED" "$REVIEW_EXIT_PARSE_ERROR")"
  if is_deny <<<"$out" && grep -Fq "usage limit reached" <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s DENY\n' "precommit_nonzero_parse_error_denies"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_nonzero_parse_error_denies: expected fail-closed parseError deny, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected DENY\n' "precommit_nonzero_parse_error_denies"
  fi
  assert_precommit_pass_payload "precommit_parse_error_fail_open_allows" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_PARSE_ERROR"
  assert_precommit_deny_payload "precommit_nested_result_denies" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_NESTED_HIGH"
  assert_precommit_deny_payload "precommit_codex_stdout_json_denies" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_CODEX_STDOUT_HIGH"
  assert_precommit_system_message "precommit_native_text_fail_open_warns" "$PAYLOAD_COMMIT" "$CONFIG_ENABLED" "$REVIEW_NATIVE_TEXT" "structured review verdict missing"
  assert_precommit_deny_payload "precommit_native_text_fail_closed_denies" "$PAYLOAD_COMMIT" "$CONFIG_FAIL_CLOSED" "$REVIEW_NATIVE_TEXT"
  assert_precommit_bash_watchdog_timeout "precommit_bash_watchdog_timeout" "$PAYLOAD_COMMIT" "$CONFIG_TIMEOUT"

  # Process-tree teardown: a reviewer that spawns a grandchild inheriting stdout
  # and outliving the parent must NOT hang the commit. With only the parent
  # killed, the grandchild keeps the stdout pipe open and the $(...) capture
  # hangs until the grandchild exits (300s). The fix kills the whole group/tree
  # so the pipe closes and the gate returns promptly with a timeout message.
  GRANDCHILD_CMD="$PRECOMMIT_TMP/reviewer-grandchild.sh"
  cat >"$GRANDCHILD_CMD" <<'SH'
#!/usr/bin/env bash
sleep 300 &
wait
SH
  chmod +x "$GRANDCHILD_CMD"
  start="$(date +%s)"
  out="$(printf '%s' "$PAYLOAD_COMMIT" | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$CONFIG_TIMEOUT" COMPOSER_CODEX_REVIEW_CMD="$GRANDCHILD_CMD" COMPOSER_FORCE_BASH_TIMEOUT=1 "$GUARD2" 2>/dev/null)"
  end="$(date +%s)"; elapsed=$((end - start))
  if is_deny <<<"$out" && grep -Fq "timed out" <<<"$out" && [[ "$elapsed" -le 12 ]]; then
    PASS=$((PASS+1)); printf '  ok    %-40s TREEKILL\n' "precommit_grandchild_pipe_closed"
  else
    FAIL=$((FAIL+1)); FAILED+=("precommit_grandchild_pipe_closed: expected timeout DENY within 12s, elapsed=${elapsed}s, got: ${out:-<empty>}"); printf '  FAIL  %-40s expected TREEKILL\n' "precommit_grandchild_pipe_closed"
  fi

  CACHE_HIT_CODEX_ROOT="$PRECOMMIT_TMP/cache-hit-codex"
  CACHE_APPROVE_CODEX_ROOT="$PRECOMMIT_TMP/cache-approve-codex"
  CACHE_GARBAGE_CODEX_ROOT="$PRECOMMIT_TMP/cache-garbage-codex"
  mkdir -p "$CACHE_HIT_CODEX_ROOT/scripts" "$CACHE_APPROVE_CODEX_ROOT/scripts" "$CACHE_GARBAGE_CODEX_ROOT/scripts"
  cat > "$CACHE_HIT_CODEX_ROOT/scripts/codex-companion.mjs" <<'JS'
process.exit(17);
JS
  cat > "$CACHE_APPROVE_CODEX_ROOT/scripts/codex-companion.mjs" <<'JS'
import { writeFileSync } from "node:fs";

if (process.env.PRECOMMIT_SYNC_MARKER) {
  writeFileSync(process.env.PRECOMMIT_SYNC_MARKER, "");
}
console.log(JSON.stringify({
  result: {
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: []
  },
  parseError: null
}));
JS
  cat > "$CACHE_GARBAGE_CODEX_ROOT/scripts/codex-companion.mjs" <<'JS'
console.log(JSON.stringify({
  result: {
    verdict: "garbage",
    summary: "bad",
    findings: [],
    next_steps: []
  },
  parseError: null
}));
JS

  CACHE_FILE="$PRECOMMIT_STATE_DIR/codex-review-cache-$(test_repo_hash).json"
  DIFF_HASH="$(test_diff_hash "$CONFIG_WARM")"
  cat >"$CACHE_FILE" <<JSON
{"hash":"$DIFF_HASH","verdict":"approve","summary":"cached ok","findings":[],"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationMs":10}
JSON
  assert_precommit_system_message "precommit_cached_verdict_hit" "$PAYLOAD_COMMIT" "$CONFIG_WARM" "" "cached"

  rm -f "$CACHE_FILE"
  out="$(run_precommit_hook_plugin "$PAYLOAD_COMMIT" "$CONFIG_WARM" "$CACHE_GARBAGE_CODEX_ROOT")"
  if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "unknown review verdict" <<<"$out" && [[ ! -f "$CACHE_FILE" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-40s SKIP\n' "precommit_unknown_verdict_not_cached"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_unknown_verdict_not_cached: expected fail-open systemMessage and no cache file; got: ${out:-<empty>} cache_exists=$([[ -f "$CACHE_FILE" ]] && printf yes || printf no)")
    printf '  FAIL  %-40s expected SKIP\n' "precommit_unknown_verdict_not_cached"
  fi
  cat >"$CACHE_FILE" <<JSON
{"hash":"$DIFF_HASH","verdict":"approve","summary":"cached ok","findings":[],"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationMs":10}
JSON

  out="$(run_precommit_hook_plugin "$PAYLOAD_COMMIT" "$CONFIG_WARM" "$CACHE_HIT_CODEX_ROOT")"
  if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "cached" <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s CACHE\n' "precommit_cached_plugin_not_invoked"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_cached_plugin_not_invoked: expected cached allow despite failing plugin companion; got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected CACHE\n' "precommit_cached_plugin_not_invoked"
  fi

  out="$(run_precommit_hook "$PAYLOAD_COMMIT" "$CONFIG_WARM" "$REVIEW_HIGH")"
  if is_deny <<<"$out" && grep -Fq "X" <<<"$out" && jq -e '.summary == "cached ok"' "$CACHE_FILE" >/dev/null 2>&1; then
    PASS=$((PASS+1))
    printf '  ok    %-40s BYPASS\n' "precommit_override_ignores_cache"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_override_ignores_cache: expected override reviewer to ignore fresh approve cache and leave cache unchanged; got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected BYPASS\n' "precommit_override_ignores_cache"
  fi

  chmod 666 "$CACHE_FILE"
  out="$(run_precommit_hook_plugin "$PAYLOAD_COMMIT" "$CONFIG_WARM" "$CACHE_APPROVE_CODEX_ROOT")"
  if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "approve" <<<"$out" && ! grep -Fq "cached" <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s SYNC\n' "precommit_world_writable_cache_ignored"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_world_writable_cache_ignored: expected sync approve and no cached message; got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected SYNC\n' "precommit_world_writable_cache_ignored"
  fi
  chmod 600 "$CACHE_FILE"

  cat >"$CACHE_FILE" <<JSON
{"hash":"$DIFF_HASH","verdict":"approve","summary":"stale ok","findings":[],"ts":"2000-01-01T00:00:00Z","durationMs":10}
JSON
  out="$(run_precommit_hook_plugin "$PAYLOAD_COMMIT" "$CONFIG_WARM" "$CACHE_APPROVE_CODEX_ROOT")"
  if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "approve" <<<"$out" && ! grep -Fq "cached" <<<"$out"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s SYNC\n' "precommit_stale_cache_fallback"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_stale_cache_fallback: expected sync approve and no cached message; got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected SYNC\n' "precommit_stale_cache_fallback"
  fi

  POLICY_A_HASH="$(test_diff_hash "$CONFIG_WARM_MODEL_A")"
  SYNC_MARKER="$PRECOMMIT_TMP/policy-sync-ran"
  rm -f "$SYNC_MARKER"
  cat >"$CACHE_FILE" <<JSON
{"hash":"$POLICY_A_HASH","verdict":"approve","summary":"cached under model a","findings":[],"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationMs":10}
JSON
  out="$(printf '%s' "$PAYLOAD_COMMIT" | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$CONFIG_WARM_MODEL_B" COMPOSER_CODEX_PLUGIN_ROOT="$CACHE_APPROVE_CODEX_ROOT" PRECOMMIT_SYNC_MARKER="$SYNC_MARKER" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$GUARD2" 2>/dev/null)"
  if ! is_deny <<<"$out" && grep -Eq '"systemMessage"[[:space:]]*:' <<<"$out" && grep -Fq "approve" <<<"$out" && ! grep -Fq "cached" <<<"$out" && [[ -f "$SYNC_MARKER" ]]; then
    PASS=$((PASS+1))
    printf '  ok    %-40s SYNC\n' "precommit_policy_change_invalidates_cache"
  else
    FAIL=$((FAIL+1))
    FAILED+=("precommit_policy_change_invalidates_cache: expected sync approve, marker, and no cached message; got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected SYNC\n' "precommit_policy_change_invalidates_cache"
  fi

  WARM_SCRIPT="${CODEX_WARM_GUARD:-$REPO_ROOT/scripts/codex_warm_review.sh}"
  if [[ ! -x "$WARM_SCRIPT" ]]; then
    FAIL=$((FAIL+1))
    FAILED+=("codex_warm_review.sh missing or not executable at $WARM_SCRIPT")
    printf '  FAIL  %-40s missing executable\n' "codex_warm_guard_exists"
  else
    CLEAN_REPO="$PRECOMMIT_TMP/clean-repo"
    mkdir -p "$CLEAN_REPO"
    git -C "$CLEAN_REPO" init -q
    git -C "$CLEAN_REPO" config user.email composer@example.test
    git -C "$CLEAN_REPO" config user.name Composer
    printf 'base\n' > "$CLEAN_REPO/a.txt"
    git -C "$CLEAN_REPO" add a.txt
    git -C "$CLEAN_REPO" commit -q -m init
    if printf '{}' | CLAUDE_PROJECT_DIR="$CLEAN_REPO" COMPOSER_CONFIG="$CONFIG_WARM" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$WARM_SCRIPT" >/dev/null 2>&1; then
      PASS=$((PASS+1))
      printf '  ok    %-40s PASS\n' "codex_warm_clean_tree_skips"
    else
      FAIL=$((FAIL+1))
      FAILED+=("codex_warm_clean_tree_skips: expected exit 0")
      printf '  FAIL  %-40s expected PASS\n' "codex_warm_clean_tree_skips"
    fi
    if printf '{}' | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$CONFIG_WARM_DISABLED" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$WARM_SCRIPT" >/dev/null 2>&1; then
      PASS=$((PASS+1))
      printf '  ok    %-40s PASS\n' "codex_warm_disabled_skips"
    else
      FAIL=$((FAIL+1))
      FAILED+=("codex_warm_disabled_skips: expected exit 0")
      printf '  FAIL  %-40s expected PASS\n' "codex_warm_disabled_skips"
    fi
    start="$(date +%s)"
    if printf '{}' | CLAUDE_PROJECT_DIR="$PRECOMMIT_GIT_ROOT" COMPOSER_CONFIG="$CONFIG_WARM_PRECOMMIT_DISABLED" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$WARM_SCRIPT" >/dev/null 2>&1; then
      hook_status=0
    else
      hook_status=$?
    fi
    end="$(date +%s)"
    elapsed=$((end - start))
    if [[ "$hook_status" -eq 0 && "$elapsed" -le 2 ]]; then
      PASS=$((PASS+1))
      printf '  ok    %-40s PASS\n' "codex_warm_precommit_disabled_skips"
    else
      FAIL=$((FAIL+1))
      FAILED+=("codex_warm_precommit_disabled_skips: expected exit 0 within 2s; status=$hook_status elapsed=${elapsed}s")
      printf '  FAIL  %-40s expected PASS\n' "codex_warm_precommit_disabled_skips"
    fi

    WARM_REPO="$PRECOMMIT_TMP/warm-repo"
    FAKE_CODEX_ROOT="$PRECOMMIT_TMP/fake-codex"
    mkdir -p "$WARM_REPO" "$FAKE_CODEX_ROOT/scripts"
    git -C "$WARM_REPO" init -q
    git -C "$WARM_REPO" config user.email composer@example.test
    git -C "$WARM_REPO" config user.name Composer
    printf 'base\n' > "$WARM_REPO/a.txt"
    git -C "$WARM_REPO" add a.txt
    git -C "$WARM_REPO" commit -q -m init
    printf 'dirty\n' >> "$WARM_REPO/a.txt"
    cat > "$FAKE_CODEX_ROOT/scripts/codex-companion.mjs" <<'JS'
console.log(JSON.stringify({
  review: "Adversarial Review",
  codex: {
    status: 0,
    stdout: JSON.stringify({
      verdict: "approve",
      summary: "ok",
      findings: [],
      next_steps: []
    })
  }
}));
JS

    WARM_REPO="$(cd "$WARM_REPO" && pwd -P)"
    WARM_REPO_HASH="$(printf '%s' "$WARM_REPO" | test_hash_string)"
    WARM_CACHE_FILE="$PRECOMMIT_STATE_DIR/codex-review-cache-${WARM_REPO_HASH}.json"
    WARM_LOCK_FILE="$PRECOMMIT_STATE_DIR/codex-warm-${WARM_REPO_HASH}.lock"
    rm -f "$WARM_CACHE_FILE" "$WARM_LOCK_FILE"
    printf '99999\n' > "$WARM_LOCK_FILE"

    start="$(date +%s)"
    if printf '{"session_id":"warm-spawn"}' | CLAUDE_PROJECT_DIR="$WARM_REPO" COMPOSER_CONFIG="$CONFIG_WARM" COMPOSER_CODEX_PLUGIN_ROOT="$FAKE_CODEX_ROOT" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" bash -u "$WARM_SCRIPT" >/dev/null 2>&1; then
      hook_status=0
    else
      hook_status=$?
    fi
    end="$(date +%s)"
    elapsed=$((end - start))

    cache_ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if [[ -f "$WARM_CACHE_FILE" ]] && jq -e '.verdict == "approve"' "$WARM_CACHE_FILE" >/dev/null 2>&1; then
        cache_ready=1
        break
      fi
      sleep 1
    done

	    if [[ "$hook_status" -eq 0 && "$elapsed" -le 5 && "$cache_ready" -eq 1 && ! -f "$WARM_LOCK_FILE" ]]; then
	      PASS=$((PASS+1))
	      printf '  ok    %-40s SPAWN\n' "codex_warm_stale_lock_spawn_cache"
	    else
	      FAIL=$((FAIL+1))
	      FAILED+=("codex_warm_stale_lock_spawn_cache: expected stale lock replacement, exit 0 within 5s, approve cache within 15s, no lock; status=$hook_status elapsed=${elapsed}s cache_ready=$cache_ready lock_exists=$([[ -f "$WARM_LOCK_FILE" ]] && printf yes || printf no)")
	      printf '  FAIL  %-40s expected SPAWN\n' "codex_warm_stale_lock_spawn_cache"
	    fi

	    WARM_OLD_TS="2000-01-01T00:00:00Z"
	    WARM_CURRENT_HASH="$(jq -r '.hash // empty' "$WARM_CACHE_FILE" 2>/dev/null || true)"
	    cat >"$WARM_CACHE_FILE" <<JSON
{"hash":"$WARM_CURRENT_HASH","verdict":"needs-attention","summary":"old","findings":[],"ts":"$WARM_OLD_TS","durationMs":10}
JSON
	    if printf '{"session_id":"warm-expired"}' | CLAUDE_PROJECT_DIR="$WARM_REPO" COMPOSER_CONFIG="$CONFIG_WARM" COMPOSER_CODEX_PLUGIN_ROOT="$FAKE_CODEX_ROOT" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" bash -u "$WARM_SCRIPT" >/dev/null 2>&1; then
	      hook_status=0
	    else
	      hook_status=$?
	    fi
	    refreshed_cache=0
	    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
	      if [[ -f "$WARM_CACHE_FILE" ]] \
	        && jq -e --arg oldTs "$WARM_OLD_TS" '.verdict == "approve" and .ts != $oldTs' "$WARM_CACHE_FILE" >/dev/null 2>&1; then
	        refreshed_cache=1
	        break
	      fi
	      sleep 1
	    done
	    if [[ "$hook_status" -eq 0 && "$refreshed_cache" -eq 1 && ! -f "$WARM_LOCK_FILE" ]]; then
	      PASS=$((PASS+1))
	      printf '  ok    %-40s SPAWN\n' "codex_warm_expired_same_hash_rewarms"
	    else
	      FAIL=$((FAIL+1))
	      FAILED+=("codex_warm_expired_same_hash_rewarms: expected expired same-hash cache to refresh; status=$hook_status refreshed_cache=$refreshed_cache lock_exists=$([[ -f "$WARM_LOCK_FILE" ]] && printf yes || printf no)")
	      printf '  FAIL  %-40s expected SPAWN\n' "codex_warm_expired_same_hash_rewarms"
	    fi

	    rm -f "$WARM_CACHE_FILE"
	    printf '%s\n' "$$" > "$WARM_LOCK_FILE"
    live_lock_before="$(cat "$WARM_LOCK_FILE" 2>/dev/null || true)"
    if printf '{"session_id":"warm-live-lock"}' | CLAUDE_PROJECT_DIR="$WARM_REPO" COMPOSER_CONFIG="$CONFIG_WARM" COMPOSER_CODEX_PLUGIN_ROOT="$FAKE_CODEX_ROOT" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" bash -u "$WARM_SCRIPT" >/dev/null 2>&1; then
      hook_status=0
    else
      hook_status=$?
    fi
    live_lock_after="$(cat "$WARM_LOCK_FILE" 2>/dev/null || true)"
    if [[ "$hook_status" -eq 0 && "$live_lock_before" == "$$" && "$live_lock_after" == "$$" && ! -f "$WARM_CACHE_FILE" ]]; then
      PASS=$((PASS+1))
      printf '  ok    %-40s LOCK\n' "codex_warm_live_foreign_lock_skips"
    else
      FAIL=$((FAIL+1))
      FAILED+=("codex_warm_live_foreign_lock_skips: expected live foreign lock to remain and no cache; status=$hook_status before=${live_lock_before:-<missing>} after=${live_lock_after:-<missing>} cache_exists=$([[ -f "$WARM_CACHE_FILE" ]] && printf yes || printf no)")
      printf '  FAIL  %-40s expected LOCK\n' "codex_warm_live_foreign_lock_skips"
    fi
    rm -f "$WARM_CACHE_FILE" "$WARM_LOCK_FILE"

    BRANCH_REPO="$PRECOMMIT_TMP/branch-repo"
    mkdir -p "$BRANCH_REPO"
    git -C "$BRANCH_REPO" init -q
    git -C "$BRANCH_REPO" config user.email composer@example.test
    git -C "$BRANCH_REPO" config user.name Composer
    git -C "$BRANCH_REPO" checkout -q -b main
    printf 'base\n' > "$BRANCH_REPO/a.txt"
    git -C "$BRANCH_REPO" add a.txt
    git -C "$BRANCH_REPO" commit -q -m base
    git -C "$BRANCH_REPO" checkout -q -b feature
    printf 'feature\n' > "$BRANCH_REPO/feature.txt"
    git -C "$BRANCH_REPO" add feature.txt
    git -C "$BRANCH_REPO" commit -q -m feature
    BRANCH_BASE_WORKTREE="$PRECOMMIT_TMP/branch-base-worktree"
    git -C "$BRANCH_REPO" worktree add -q "$BRANCH_BASE_WORKTREE" main
    printf 'dirty\n' >> "$BRANCH_REPO/feature.txt"
    BRANCH_REPO="$(cd "$BRANCH_REPO" && pwd -P)"
    BRANCH_REPO_HASH="$(printf '%s' "$BRANCH_REPO" | test_hash_string)"
    BRANCH_CACHE_FILE="$PRECOMMIT_STATE_DIR/codex-review-cache-${BRANCH_REPO_HASH}.json"
    rm -f "$BRANCH_CACHE_FILE" /tmp/composer-codex-review-log.jsonl
    out="$(printf '%s' "$PAYLOAD_COMMIT" | CLAUDE_PROJECT_DIR="$BRANCH_REPO" COMPOSER_CONFIG="$CONFIG_BRANCH_WARM" COMPOSER_CODEX_PLUGIN_ROOT="$CACHE_APPROVE_CODEX_ROOT" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$GUARD2" 2>/dev/null)"
    first_branch_hash="$(jq -r 'select(.scope == "branch") | .diff_hash' /tmp/composer-codex-review-log.jsonl 2>/dev/null | tail -n 1)"
    rm -f "$BRANCH_CACHE_FILE"
    printf 'base advance\n' >> "$BRANCH_BASE_WORKTREE/base.txt"
    git -C "$BRANCH_BASE_WORKTREE" add base.txt
    git -C "$BRANCH_BASE_WORKTREE" commit -q -m "advance base"
    out="$(printf '%s' "$PAYLOAD_COMMIT" | CLAUDE_PROJECT_DIR="$BRANCH_REPO" COMPOSER_CONFIG="$CONFIG_BRANCH_WARM" COMPOSER_CODEX_PLUGIN_ROOT="$CACHE_APPROVE_CODEX_ROOT" COMPOSER_STATE_DIR="$PRECOMMIT_STATE_DIR" "$GUARD2" 2>/dev/null)"
    second_branch_hash="$(jq -r 'select(.scope == "branch") | .diff_hash' /tmp/composer-codex-review-log.jsonl 2>/dev/null | tail -n 1)"
    if [[ -n "$first_branch_hash" && -n "$second_branch_hash" && "$first_branch_hash" != "$second_branch_hash" ]]; then
      PASS=$((PASS+1))
      printf '  ok    %-40s HASH\n' "precommit_branch_base_advance_hash"
    else
      FAIL=$((FAIL+1))
      FAILED+=("precommit_branch_base_advance_hash: expected different branch diff_hash values; first=${first_branch_hash:-<missing>} second=${second_branch_hash:-<missing>}")
      printf '  FAIL  %-40s expected HASH\n' "precommit_branch_base_advance_hash"
    fi
  fi
fi

echo
echo "=== learn.sh timeout harness ==="

LEARN_SCRIPT="${LEARN_HOOK:-$REPO_ROOT/scripts/learn.sh}"
if [[ ! -x "$LEARN_SCRIPT" ]]; then
  FAIL=$((FAIL+1))
  FAILED+=("learn.sh missing or not executable at $LEARN_SCRIPT")
  printf '  FAIL  %-40s missing executable\n' "learn_hook_exists"
else
  LEARN_TMP="$(mktemp -d -t composer_learn_timeout.XXXXXX)"
  mkdir -p "$LEARN_TMP/bin" "$LEARN_TMP/project" "$LEARN_TMP/project/.claude/learnings"
  cat >"$LEARN_TMP/bin/jq" <<'SH'
#!/usr/bin/env bash
sleep 30
SH
  chmod +x "$LEARN_TMP/bin/jq"
  LEARN_LOG="$LEARN_TMP/learn.jsonl"
  LEARN_TRANSCRIPT="$LEARN_TMP/transcript.jsonl"
  printf '%s\n' '{"role":"user","content":"wrong, please do not do that"}' > "$LEARN_TRANSCRIPT"
  start="$(date +%s)"
  if printf '{"transcript_path":"%s"}' "$LEARN_TRANSCRIPT" | PATH="$LEARN_TMP/bin:$PATH" CLAUDE_PROJECT_DIR="$LEARN_TMP/project" COMPOSER_LEARN_HOOK_TIMEOUT_MS=1000 COMPOSER_LEARN_LOG="$LEARN_LOG" "$LEARN_SCRIPT" >/dev/null 2>&1; then
    learn_status=0
  else
    learn_status=$?
  fi
  end="$(date +%s)"
  elapsed=$((end - start))
  if [[ "$learn_status" -eq 0 && "$elapsed" -le 5 ]] \
     && grep -Fq '"reason_code":"hook_timeout"' "$LEARN_LOG" \
     && grep -Fq '"stage":"learn_stop"' "$LEARN_LOG"; then
    PASS=$((PASS+1))
    printf '  ok    %-40s TIMEOUT\n' "learn_jq_timeout_exits_cleanly"
  else
    FAIL=$((FAIL+1))
    FAILED+=("learn_jq_timeout_exits_cleanly: expected exit 0 <=5s with hook_timeout log; status=$learn_status elapsed=${elapsed}s log=$(cat "$LEARN_LOG" 2>/dev/null || true)")
    printf '  FAIL  %-40s expected TIMEOUT\n' "learn_jq_timeout_exits_cleanly"
  fi
fi


echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$PASS" "$FAIL"

if (( FAIL > 0 )); then
  echo
  echo "Failures:"
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi

echo
echo "=== dispatch_guard.sh fixture harness ==="

DISPATCH_SCRIPT="${DISPATCH_GUARD:-$REPO_ROOT/scripts/dispatch_guard.sh}"
if [[ ! -x "$DISPATCH_SCRIPT" ]]; then
  echo "FAIL: dispatch_guard.sh missing or not executable at $DISPATCH_SCRIPT" >&2
  exit 1
fi

DISPATCH_PASS=0
DISPATCH_FAIL=0
declare -a DISPATCH_FAILED

assert_dispatch_hint_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$DISPATCH_SCRIPT" 2>&1)"
  if grep -Eq '"additionalContext"[[:space:]]*:[[:space:]]*"dispatch-hint:' <<<"$out" \
     && grep -Eq 'route=composer-code-cli' <<<"$out" \
     && grep -Eq 'class=cross-file-code' <<<"$out" \
     && grep -Eq 'tier=premium' <<<"$out" \
     && grep -Eq 'size=full' <<<"$out" \
     && ! is_deny <<<"$out"; then
    DISPATCH_PASS=$((DISPATCH_PASS+1))
    printf '  ok    %-40s HINT\n' "$name"
  else
    DISPATCH_FAIL=$((DISPATCH_FAIL+1))
    DISPATCH_FAILED+=("$name: expected hint allow JSON, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected HINT\n' "$name"
  fi
}

assert_dispatch_any_hint_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$DISPATCH_SCRIPT" 2>&1)"
  if grep -Eq '"additionalContext"[[:space:]]*:[[:space:]]*"dispatch-hint:' <<<"$out" \
     && ! is_deny <<<"$out"; then
    DISPATCH_PASS=$((DISPATCH_PASS+1))
    printf '  ok    %-40s HINT\n' "$name"
  else
    DISPATCH_FAIL=$((DISPATCH_FAIL+1))
    DISPATCH_FAILED+=("$name: expected non-deny hint JSON, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected HINT\n' "$name"
  fi
}

assert_dispatch_deny_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$DISPATCH_SCRIPT" 2>&1)"
  if is_deny <<<"$out"; then
    DISPATCH_PASS=$((DISPATCH_PASS+1))
    printf '  ok    %-40s DENY\n' "$name"
  else
    DISPATCH_FAIL=$((DISPATCH_FAIL+1))
    DISPATCH_FAILED+=("$name: expected DENY, got: ${out:-<empty>}")
    printf '  FAIL  %-40s expected DENY\n' "$name"
  fi
}

assert_dispatch_pass_payload() {
  local name="$1" payload="$2" out
  out="$(printf '%s' "$payload" | "$DISPATCH_SCRIPT" 2>&1)"
  if is_deny <<<"$out"; then
    DISPATCH_FAIL=$((DISPATCH_FAIL+1))
    DISPATCH_FAILED+=("$name: expected PASS, got DENY: $out")
    printf '  FAIL  %-40s expected PASS\n' "$name"
  else
    DISPATCH_PASS=$((DISPATCH_PASS+1))
    printf '  ok    %-40s PASS\n' "$name"
  fi
}

assert_dispatch_hint_payload "dispatch_hint_additional_context" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","description":"refactor","prompt":"Refactor src/server.ts architecture across multi-file tests/server.test.ts"},"session_id":"t"}'
assert_dispatch_deny_payload "dispatch_destructive_tiny_still_denied" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","prompt":"rm -rf node_modules"},"session_id":"t"}'
assert_dispatch_deny_payload "dispatch_short_destructive_denied" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","description":"cleanup","prompt":"rm -rf node_modules"},"session_id":"t"}'
assert_dispatch_deny_payload "dispatch_padded_destructive_denied" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","description":"cleanup","prompt":"Please inspect the repository carefully and provide detailed context before doing anything. This padding is intentionally long enough to pass any old tiny-prompt heuristic while still containing the destructive command rm -rf node_modules that must be blocked unconditionally by the guard."},"session_id":"t"}'
assert_dispatch_any_hint_payload "dispatch_benign_short_passes_with_hint" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","description":"check","prompt":"Inspect src/index.ts"},"session_id":"t"}'
assert_dispatch_pass_payload "dispatch_non_task_passes_open" \
  '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"src/index.ts"},"session_id":"t"}'

DISPATCH_TIMEOUT_TMP="$(mktemp -d -t composer_dispatch_timeout.XXXXXX)"
mkdir -p "$DISPATCH_TIMEOUT_TMP/node_modules/.bin" "$DISPATCH_TIMEOUT_TMP/src/cli" "$DISPATCH_TIMEOUT_TMP/scripts"
cat >"$DISPATCH_TIMEOUT_TMP/node_modules/.bin/tsx" <<'SH'
#!/usr/bin/env bash
sleep 30
SH
chmod +x "$DISPATCH_TIMEOUT_TMP/node_modules/.bin/tsx"
touch "$DISPATCH_TIMEOUT_TMP/src/cli/dispatch-hint.ts"
cat >"$DISPATCH_TIMEOUT_TMP/reaper-stub.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$COMPOSER_REAPER_STUB_LOG"
exit 0
SH
chmod +x "$DISPATCH_TIMEOUT_TMP/reaper-stub.sh"
DISPATCH_TIMEOUT_LOG="$DISPATCH_TIMEOUT_TMP/dispatch.jsonl"
DISPATCH_REAPER_LOG="$DISPATCH_TIMEOUT_TMP/reaper.log"
start="$(date +%s)"
out="$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","description":"check","prompt":"Inspect src/index.ts"},"session_id":"t"}' | CLAUDE_PROJECT_DIR="$DISPATCH_TIMEOUT_TMP" COMPOSER_DISPATCH_GUARD_TIMEOUT_MS=1000 COMPOSER_DISPATCH_LOG="$DISPATCH_TIMEOUT_LOG" COMPOSER_CUA_REAPER="$DISPATCH_TIMEOUT_TMP/reaper-stub.sh" COMPOSER_REAPER_STUB_LOG="$DISPATCH_REAPER_LOG" "$DISPATCH_SCRIPT" 2>&1)"
end="$(date +%s)"
elapsed=$((end - start))
if ! is_deny <<<"$out" && [[ "$elapsed" -le 5 ]] \
   && jq -e 'select(.reason_code == "dispatch_timeout" and .stage == "dispatch_hint" and (.elapsed_wall_ms | type) == "number")' "$DISPATCH_TIMEOUT_LOG" >/dev/null 2>&1 \
   && grep -Fq -- "--register" "$DISPATCH_REAPER_LOG"; then
  DISPATCH_PASS=$((DISPATCH_PASS+1))
  printf '  ok    %-40s TIMEOUT\n' "dispatch_hint_timeout_bounded"
else
  DISPATCH_FAIL=$((DISPATCH_FAIL+1))
  DISPATCH_FAILED+=("dispatch_hint_timeout_bounded: expected fail-open timeout <=5s with dispatch_timeout log and reaper registration; elapsed=${elapsed}s out=${out:-<empty>}")
  printf '  FAIL  %-40s expected TIMEOUT\n' "dispatch_hint_timeout_bounded"
fi

export COMPOSER_ENABLED=0
assert_dispatch_pass_payload "dispatch_disabled_passes_destructive_task" \
  '{"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"subagent_type":"coder","prompt":"rm -rf node_modules"},"session_id":"t"}'
unset COMPOSER_ENABLED

echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$DISPATCH_PASS" "$DISPATCH_FAIL"

if (( DISPATCH_FAIL > 0 )); then
  echo
  echo "Dispatch guard failures:"
  printf '  - %s\n' "${DISPATCH_FAILED[@]}"
  exit 1
fi
