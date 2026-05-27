#!/usr/bin/env bash
# Composer boundary enforcement (PreToolUse hook) — pragmatic profile for
# daily dev in arbitrary projects.
#
# Behaviour:
#   - Denies Edit/Write/NotebookEdit on the main thread → forces dispatch via
#     Task(subagent_type="coder") so GLM does code changes.
#   - Allows Bash on the main thread (light shell ops stay inline).
#   - Allows Edit/Write inside a subagent — that is how `coder` applies the
#     patch composer_code returned. Detection covers three field-name shapes
#     Claude Code has emitted across versions: transcript_path containing
#     "/subagents/", agent_id/agentId set, is_sidechain/isSidechain true.
#   - Wraps the deny decision in {"hookSpecificOutput":{...}} as Claude Code
#     v2.1.150 requires; top-level fields parse cleanly but are ignored.
#
# Disable per-session with: COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS=1 claude

set -u

emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: jq missing, failing closed"}}\n'
  exit 0
fi

INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  emit_deny "boundary_guard: empty stdin, failing closed"
fi

TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)"
if [[ -z "$TOOL" ]]; then
  emit_deny "boundary_guard: malformed JSON or missing tool_name, failing closed"
fi

BYPASS="${COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS:-}"
if [[ "$BYPASS" == "1" || "$BYPASS" == "true" ]]; then
  printf 'WARN boundary_guard: COMPOSER_DANGEROUSLY_BYPASS_PERMISSIONS=%s — boundary disabled, dev mode only\n' "$BYPASS" >&2
  exit 0
fi

STOP_FILE="${COMPOSER_STOP_EVOLVE_FILE:-${CLAUDE_PROJECT_DIR:-.}/STOP_EVOLVE}"
if [[ -e "$STOP_FILE" ]] && [[ "$TOOL" == mcp__composer__* ]]; then
  emit_deny "STOP_EVOLVE sentinel present at $STOP_FILE — Composer dispatches paused."
fi

# Subagent context bypass — coder must Edit/Write to apply GLM's patch.
TRANSCRIPT="$(jq -r '.transcript_path // empty' <<<"$INPUT" 2>/dev/null)"
AGENT_ID="$(jq -r '.agent_id // .agentId // empty' <<<"$INPUT" 2>/dev/null)"
SIDECHAIN="$(jq -r '.is_sidechain // .isSidechain // empty' <<<"$INPUT" 2>/dev/null)"
if [[ "$TRANSCRIPT" == */subagents/* ]] \
   || [[ -n "$AGENT_ID" ]] \
   || [[ "$SIDECHAIN" == "true" ]]; then
  exit 0
fi

case "$TOOL" in
  Edit|Write|NotebookEdit \
  | mcp__*__write_file | mcp__*__edit_file \
  | mcp__*__write | mcp__*__edit)
    emit_deny "DENY: dispatch Task(subagent_type=\"coder\"); no Bash workaround."
    ;;
esac

exit 0
