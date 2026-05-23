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

# Malformed / failure modes — must fail closed
assert_deny_fixture "malformed_missing_tool_name" "15_malformed_missing_tool_name.json"
assert_deny_payload "malformed_not_json"          "this-is-not-json{"
assert_deny_payload "empty_stdin"                 ""

echo
echo "------------------------------------------"
printf '  PASS: %d\n  FAIL: %d\n' "$PASS" "$FAIL"

if (( FAIL > 0 )); then
  echo
  echo "Failures:"
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
