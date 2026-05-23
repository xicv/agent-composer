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
