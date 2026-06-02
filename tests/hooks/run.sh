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

# Block list — native tools
assert_deny_fixture "block_bash"          "01_block_bash.json"
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
assert_deny_payload "stop_evolve_with_bash_still_denied" \
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

# COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS (Wave 3 Step 1)
export COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS=true
assert_pass_payload "bypass_allows_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"t"}'
assert_pass_payload "bypass_allows_edit" \
  '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"x","old_string":"a","new_string":"b"},"session_id":"t"}'
assert_pass_payload "bypass_allows_write" \
  '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"x","content":"y"},"session_id":"t"}'
unset COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS
assert_deny_payload "no_bypass_still_blocks_bash" \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"t"}'


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
assert_dispatch_pass_payload "dispatch_non_task_passes_open" \
  '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"src/index.ts"},"session_id":"t"}'

echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$DISPATCH_PASS" "$DISPATCH_FAIL"

if (( DISPATCH_FAIL > 0 )); then
  echo
  echo "Dispatch guard failures:"
  printf '  - %s\n' "${DISPATCH_FAILED[@]}"
  exit 1
fi
