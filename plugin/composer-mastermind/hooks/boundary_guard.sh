#!/usr/bin/env bash
# Wave 1 F1.5 — Composer boundary enforcement (PreToolUse hook).
# Contract per docs/adr/0001-contracts.md §C0.4:
#   stdin:  Anthropic PreToolUse JSON
#   stdout: optional {"permissionDecision":"deny"|"allow"|"ask", ...}
#   exit:   always 0; semantics carried by JSON
# Fail-closed: any unexpected condition (missing jq / empty stdin /
# malformed JSON / absent tool_name) MUST emit a deny payload.
# Scope: GLOBAL. When Composer is enabled, this hook denies main-thread
# file-mutation tools in every repo and every path. Enforcement is controlled
# only by kill switches such as ~/.claude/composer.disabled or /composer disable.

set -u

composer_disabled() {
  case "${COMPOSER_ENABLED:-}" in
    0|false|FALSE|off|OFF|no|NO) return 0 ;;
  esac
  case "${COMPOSER_DISABLED:-}" in
    1|true|TRUE|on|ON|yes|YES) return 0 ;;
  esac
  if [[ -n "${COMPOSER_DISABLED_FILE:-}" && -e "$COMPOSER_DISABLED_FILE" ]]; then
    return 0
  fi
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -e "$CLAUDE_PROJECT_DIR/.composer-disabled" ]]; then
    return 0
  fi
  if [[ -n "${HOME:-}" && -e "$HOME/.claude/composer.disabled" ]]; then
    return 0
  fi
  return 1
}

if composer_disabled; then
  exit 0
fi

emit_deny() {
  local reason="$1"
  # Claude Code v2.1.150+ requires the decision wrapped in hookSpecificOutput.
  # Top-level {hookEventName,permissionDecision,permissionDecisionReason} is
  # parsed without error but silently ignored — Edit/Update/Write succeed anyway.
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# 1. Dependency: jq is mandatory for safe JSON parsing.
if ! command -v jq >/dev/null 2>&1; then
  # Cannot use emit_deny (depends on jq); inline fallback.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boundary_guard: jq missing, failing closed"}}\n'
  exit 0
fi

# 2. Read tool-call JSON from stdin.
if command -v timeout >/dev/null 2>&1; then
  INPUT="$(timeout 5 cat 2>/dev/null || true)"
else
  INPUT="$(cat || true)"
fi
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

# 3.7. Subagent context bypass.
#   Composer's coder subagent must Edit/Update/Write to apply GLM's patch output.
#   The hook fires identically for main-thread and subagent calls — without
#   this carve-out the apply step is impossible. Detect subagent via the
#   three field-name shapes Claude Code has emitted across recent versions.
TRANSCRIPT="$(jq -r '.transcript_path // empty' <<<"$INPUT" 2>/dev/null)"
AGENT_ID="$(jq -r '.agent_id // .agentId // empty' <<<"$INPUT" 2>/dev/null)"
AGENT_NAME="$(jq -r '.agent_name // .agentName // .subagent_type // .subagentType // .tool_input.subagent_type // empty' <<<"$INPUT" 2>/dev/null)"
SIDECHAIN="$(jq -r '.is_sidechain // .isSidechain // empty' <<<"$INPUT" 2>/dev/null)"
if [[ "$TRANSCRIPT" == */subagents/* ]] \
   || [[ "$TRANSCRIPT" == */agents/* ]] \
   || [[ -n "$AGENT_ID" ]] \
   || [[ -n "$AGENT_NAME" ]] \
   || [[ "$SIDECHAIN" == "true" ]]; then
  exit 0
fi

# 3.8. Brain housekeeping carve-out.
#   Claude (the orchestrator / "brain") must persist its OWN state — e.g.
#   cross-session memory — even while enforcement is ON. These paths are NOT
#   project code, so routing them through the executor adds no safety. Allow a
#   main-thread mutation whose target path is under an approved brain-state
#   root. Default: the Claude memory store. Extra roots may be added via
#   COMPOSER_GUARD_ALLOW_GLOBS (colon-separated case globs). Paths containing a
#   ".." traversal segment are NEVER allow-listed, so an allowed prefix cannot
#   be used to escape into ~/.claude/hooks or similar. Tools without a file
#   path (Bash, mcp exec/bash) have no FILE and fall through to the block list.
FILE="$(jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // empty' <<<"$INPUT" 2>/dev/null)"
if [[ -n "$FILE" && "$FILE" != *"/../"* && "$FILE" != *"/.." ]]; then
  brain_globs="$HOME/.claude/projects/*/memory/*"
  if [[ -n "${COMPOSER_GUARD_ALLOW_GLOBS:-}" ]]; then
    brain_globs="$brain_globs:$COMPOSER_GUARD_ALLOW_GLOBS"
  fi
  set -f
  brain_old_ifs="$IFS"
  IFS=':'
  for glob in $brain_globs; do
    [[ -z "$glob" ]] && continue
    # shellcheck disable=SC2254
    case "$FILE" in
      $glob)
        IFS="$brain_old_ifs"
        set +f
        exit 0
        ;;
    esac
  done
  IFS="$brain_old_ifs"
  set +f
fi

# 4. Block list — native dangerous file-mutating tools + MCP-prefixed variants.
# Native Bash is allowed on the main thread for inspection and verification;
# the orchestrator skill still forbids using Bash to author code or perform
# destructive state changes. MCP exec/bash wrappers stay blocked because they
# bypass Claude Code's native Bash permissions surface.
case "$TOOL" in
  Edit|Update|Write|NotebookEdit \
  | mcp__*__write_file | mcp__*__edit_file | mcp__*__bash \
  | mcp__*__write | mcp__*__edit | mcp__*__exec)
    emit_deny "Composer is handling file edits. Route this change through composer_code_cli (or composer_code_chain), or run /composer disable to edit directly. Bash inspection stays available."
    ;;
esac

# 5. Pass-through. Emit nothing — Anthropic treats absent JSON + exit 0
#    as implicit allow. (Explicit allow JSON is also valid but noisier.)
exit 0
