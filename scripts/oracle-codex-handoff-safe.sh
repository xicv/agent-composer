#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/oracle-codex-handoff-safe.sh [--mode deep|review|debug|standard] [--exec] -- "feature/request"

Creates a ChatGPT Pro/Oracle plan under .composer/handoffs/ and optionally sends it to Codex.
USAGE
}

MODE="deep"
EXECUTE=0
PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --exec) EXECUTE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; PROMPT="$*"; break ;;
    *) if [[ -z "$PROMPT" ]]; then PROMPT="$1"; else PROMPT="$PROMPT $1"; fi; shift ;;
  esac
done
[[ -n "$PROMPT" ]] || { usage >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORACLE_SCRIPT="$ROOT_DIR/scripts/oracle-pro-safe.sh"
mkdir -p .composer/handoffs .composer/results
slug="$(date +%Y%m%d-%H%M%S)-oracle-handoff"
plan_path=".composer/handoffs/$slug.md"

handoff_prompt="Create a compact Codex-ready implementation handoff for the following request. Include objective, constraints, likely files, implementation steps, tests, risks, and acceptance criteria. Do not include long code blocks unless essential. Request: $PROMPT"

answer_path="$($ORACLE_SCRIPT --mode "$MODE" --slug "$slug" -- "$handoff_prompt" | tail -1)"
[[ -f "$answer_path" ]] || { echo "Oracle did not produce an answer path" >&2; exit 1; }
cp "$answer_path" "$plan_path"
echo "$plan_path"

if [[ "$EXECUTE" -eq 1 ]]; then
  result_path=".composer/results/$slug.codex-result.md"
  {
    echo "Implement the following plan in the current repository. Keep the diff focused. Run relevant tests. Return summary, changed files, tests run, and unresolved risks."
    echo
    cat "$plan_path"
  } | codex exec --sandbox workspace-write --ask-for-approval on-request --output-last-message "$result_path" -
  echo "$result_path"
fi
