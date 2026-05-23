#!/usr/bin/env bash
# Wave 3 Step 1 — PR-gate for autoresearch diff scope.
# Per docs/adr/0003-self-evolution.md (forthcoming), autoresearch-generated
# diffs may only touch files matching the whitelist below. Anything else
# fails the gate. CI runs this on PRs; pre-commit hooks may also wire it.
#
# Usage:
#   evolve_check_diff.sh path1 path2 ...    # explicit list
#   evolve_check_diff.sh --staged           # git diff --cached --name-only
#   evolve_check_diff.sh --diff <base-ref>  # git diff --name-only <base>
#
# Exit codes:
#   0 — every path matches the whitelist (or list empty after filtering)
#   1 — at least one path outside whitelist (offenders printed to stderr)
#   2 — usage error (no args, no flag, or --diff without base ref)

set -u

PATTERNS=(
  '^\.claude/agents/[^/]+\.md$'
  '^\.claude/skills/composer-mastermind/SKILL\.md$'
  '^evals/tasks/[^/]+\.json$'
  '^evals/tasks\.jsonl$'
)

is_whitelisted() {
  local pat
  for pat in "${PATTERNS[@]}"; do
    if printf '%s\n' "$1" | grep -Eq "$pat"; then
      return 0
    fi
  done
  return 1
}

paths=()
case "${1:-}" in
  --staged)
    while IFS= read -r line; do paths+=("$line"); done < <(git diff --cached --name-only)
    ;;
  --diff)
    if [[ -z "${2:-}" ]]; then
      printf 'evolve_check_diff: --diff requires a base ref\n' >&2
      exit 2
    fi
    while IFS= read -r line; do paths+=("$line"); done < <(git diff --name-only "$2")
    ;;
  '')
    printf 'usage: evolve_check_diff.sh <path>... | --staged | --diff <base-ref>\n' >&2
    exit 2
    ;;
  *)
    paths=("$@")
    ;;
esac

violations=()
checked=0
for p in "${paths[@]}"; do
  [[ -z "$p" ]] && continue
  checked=$((checked+1))
  if ! is_whitelisted "$p"; then
    violations+=("$p")
  fi
done

if (( ${#violations[@]} > 0 )); then
  printf 'evolve_check_diff: FAIL — paths outside autoresearch whitelist:\n' >&2
  printf '  - %s\n' "${violations[@]}" >&2
  printf '\nAllowed patterns:\n' >&2
  printf '  - %s\n' "${PATTERNS[@]}" >&2
  exit 1
fi

printf 'evolve_check_diff: OK (%d path(s) checked)\n' "$checked"
exit 0
