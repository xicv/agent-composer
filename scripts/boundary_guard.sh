#!/usr/bin/env bash
# Wave 1 F1.5 — Composer boundary enforcement (PreToolUse hook).
# Contract per docs/adr/0001-contracts.md §C0.4:
#   stdin:  Anthropic PreToolUse JSON
#   stdout: optional {"permissionDecision":"deny"|"allow"|"ask", ...}
#   exit:   always 0; semantics carried by JSON
# Fail-closed: any unexpected condition (missing jq / empty stdin /
# malformed JSON / absent tool_name) MUST emit a deny payload.

set -u

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" \
    '{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}' 2>/dev/null \
    || printf '{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}\n' "$reason"
  exit 0
}

# 1. Dependency: jq is mandatory for safe JSON parsing.
if ! command -v jq >/dev/null 2>&1; then
  # Cannot use emit_deny (depends on jq); inline fallback.
  printf '{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: jq missing, failing closed"}\n'
  exit 0
fi

# 2. Read tool-call JSON from stdin.
INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  emit_deny "boundary_guard: empty stdin, failing closed"
fi

# 3. Parse tool_name. jq surfaces parse errors to stderr (suppressed) and
#    returns empty on missing/null — both treated as malformed.
TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)"
if [[ -z "$TOOL" ]]; then
  emit_deny "boundary_guard: malformed JSON or missing tool_name, failing closed"
fi

# 3.5. COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS (dev-only escape hatch).
#   When env var equals "1" or "true", allow every tool. Stderr-warns on
#   every invocation so the bypass is visible in transcripts. Intended
#   for bootstrap / dev sessions only. NEVER set in CI or runtime.
#   See ADR 0001 amendment (2026-05-23, Wave-3 Step 1).
BYPASS="${COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS:-}"
if [[ "$BYPASS" == "1" || "$BYPASS" == "true" ]]; then
  printf 'WARN boundary_guard: COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS=%s — boundary disabled, dev mode only\n' "$BYPASS" >&2
  exit 0
fi

# 3.6. STOP_EVOLVE killswitch.
#   If sentinel file exists AND the tool is a composer dispatch, deny.
#   Sentinel path overridable via COMPOSER_STOP_EVOLVE_FILE (tests use
#   a temp file); default "$CLAUDE_PROJECT_DIR/STOP_EVOLVE", falling
#   back to "./STOP_EVOLVE" when CLAUDE_PROJECT_DIR is unset.
STOP_FILE="${COMPOSER_STOP_EVOLVE_FILE:-${CLAUDE_PROJECT_DIR:-.}/STOP_EVOLVE}"
if [[ -e "$STOP_FILE" ]] && [[ "$TOOL" == mcp__composer__* ]]; then
  emit_deny "STOP_EVOLVE sentinel present at $STOP_FILE — Composer dispatches paused."
fi

# 4. Block list — native dangerous tools + MCP-prefixed variants.
case "$TOOL" in
  Bash|Edit|Write|NotebookEdit \
  | mcp__*__write_file | mcp__*__edit_file | mcp__*__bash \
  | mcp__*__write | mcp__*__edit | mcp__*__exec)
    emit_deny "Composer orchestrator forbids direct ${TOOL}. Delegate via Task to researcher / coder / reviewer."
    ;;
esac

# 5. Pass-through. Emit nothing — Anthropic treats absent JSON + exit 0
#    as implicit allow. (Explicit allow JSON is also valid but noisier.)
exit 0
