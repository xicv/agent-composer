#!/usr/bin/env bash
# oracle-plan-mcp.sh — thin MCP-facing wrapper around oracle-pro-safe.sh.
#
# Why: CLIProvider returns a role's STDOUT to the orchestrator. oracle-pro-safe.sh
# prints the answer FILE PATH on its last stdout line (a contract relied on by
# oracle-codex-handoff-safe.sh), and oracle's own render/progress is noisy. This
# wrapper runs oracle-pro-safe.sh, recovers that path, and emits ONLY the final
# answer file CONTENT on stdout, so composer_oracle_plan returns clean answer text.
set -euo pipefail

MODE="auto"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?missing --mode value}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --) shift; ARGS+=("$@"); break ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

PROMPT="${ARGS[*]:-}"
if [[ -z "$PROMPT" && ! -t 0 ]]; then
  PROMPT="$(cat)"
fi
if [[ -z "$PROMPT" ]]; then
  echo "oracle-plan-mcp: prompt required" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORACLE_SCRIPT="$ROOT_DIR/scripts/oracle-pro-safe.sh"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Capture oracle-pro-safe stdout (answer render + final path line) into tmp.
# Its stderr (logs/progress) is inherited -> our stderr -> not returned to MCP.
set +e
bash "$ORACLE_SCRIPT" --mode "$MODE" -- "$PROMPT" > "$tmp"
status=$?
set -e

if (( status != 0 )); then
  echo "oracle-plan-mcp: oracle-pro-safe.sh failed (exit $status); captured output:" >&2
  cat "$tmp" >&2 || true
  exit "$status"
fi

answer_path="$(tail -n 1 "$tmp" | tr -d '\r')"
if [[ -z "$answer_path" || ! -s "$answer_path" ]]; then
  echo "oracle-plan-mcp: oracle finished but no answer file at '$answer_path'; captured output:" >&2
  cat "$tmp" >&2 || true
  exit 1
fi

cat "$answer_path"
