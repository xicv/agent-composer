#!/usr/bin/env bash
set -euo pipefail

# Router intended for agent-composer's existing `researcher` cli provider.
# Composer appends the prompt as the final argv item; this wrapper joins args into one prompt.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORACLE_SCRIPT="${ORACLE_COMPOSER_ORACLE_SCRIPT:-$ROOT_DIR/scripts/oracle-pro-safe.sh}"
CODEX_BIN="${ORACLE_COMPOSER_CODEX_BIN:-codex}"

prompt="$*"
[[ -n "$prompt" ]] || { echo "composer-oracle-router-safe: prompt required" >&2; exit 1; }

lower="$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')"

route="codex"
mode="standard"

case "$lower" in
  *'[codex]'*) route="codex" ;;
  *'[oracle:quick]'*) route="oracle"; mode="quick" ;;
  *'[oracle:standard]'*) route="oracle"; mode="standard" ;;
  *'[oracle:deep]'*|*'[oracle:plan]'*) route="oracle"; mode="deep" ;;
  *'[oracle:review]'*) route="oracle"; mode="review" ;;
  *'[oracle:debug]'*) route="oracle"; mode="debug" ;;
  *'[oracle:research]'*) route="oracle"; mode="research" ;;
esac

if [[ "$route" != "codex" ]]; then
  if [[ ${#prompt} -gt 2500 ]] || [[ "$lower" =~ (architecture|architectural|design|plan|planning|proposal|migration|refactor|roadmap|tradeoff|trade-off|spec|handoff|implementation[[:space:]]+plan) ]]; then mode="deep"; fi
  if [[ "$lower" =~ (review|audit|regression|security|compatibility|api[[:space:]]+break|edge[[:space:]]+case|risk) ]]; then mode="review"; fi
  if [[ "$lower" =~ (debug|root[ -]?cause|failing|failure|flaky|bug|stack[[:space:]]+trace|exception|crash|deadlock|race) ]]; then mode="debug"; fi
  if [[ "$lower" =~ (research|compare[[:space:]]+options|survey|citations|latest|web) ]]; then mode="research"; fi
fi

if [[ "$route" == "codex" ]]; then
  if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
    echo "[router] Codex requested but '$CODEX_BIN' not found; falling back to Oracle quick." >&2
    exec "$ORACLE_SCRIPT" --mode quick -- "$prompt"
  fi
  echo "[router] route=codex sandbox=read-only" >&2
  printf "%s\n" "$prompt" | "$CODEX_BIN" exec --ephemeral --sandbox read-only --ask-for-approval never -
  exit $?
else
  echo "[router] route=oracle mode=$mode" >&2
  exec "$ORACLE_SCRIPT" --mode "$mode" -- "$prompt"
fi
