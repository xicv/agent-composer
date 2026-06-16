#!/usr/bin/env bash
# Wave 1 F1.5 — Composer boundary enforcement (PreToolUse hook).
# Contract per docs/adr/0001-contracts.md §C0.4:
#   stdin:  Anthropic PreToolUse JSON
#   stdout: optional {"permissionDecision":"deny"|"allow"|"ask", ...}
#   exit:   always 0; semantics carried by JSON
# Fail-closed: any unexpected condition (missing jq / empty stdin /
# malformed JSON / absent tool_name) MUST emit a deny payload.

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

# Scope to the Composer project only. The hook is wired globally
# (~/.claude/settings.json) and fires in every project; without this,
# main-thread Edit/Write is blocked everywhere — even unrelated repos and
# ~/.claude config. Enforce the brain/executor boundary ONLY when the active
# project is the Composer repo, detected by its unique root marker.
#
# Walk ancestors from the active dir so the guard still fires when invoked
# from a SUBDIRECTORY of the repo with CLAUDE_PROJECT_DIR unset — checking
# the marker on $PWD alone fails OPEN inside the repo. Sets COMPOSER_ROOT to
# the canonical (physical) repo root, reused by the outside-repo check below.
COMPOSER_ROOT=""
composer_project() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  dir="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -e "$dir/composer.config.schema.json" ]]; then
      COMPOSER_ROOT="$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  if [[ -e "/composer.config.schema.json" ]]; then
    COMPOSER_ROOT="/"
    return 0
  fi
  return 1
}
if ! composer_project; then
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

# Allow when the target file is CONFIDENTLY OUTSIDE the Composer repo. The
# boundary exists to keep main Claude from mutating Composer's own code; a
# file outside the repo root is not Composer code. Canonicalize both the
# repo root (COMPOSER_ROOT, already physical) and the target path before
# comparing, so symlinks, `..` traversal, and macOS /tmp->/private/tmp
# cannot smuggle an in-repo path past a naive string prefix. FAIL SAFE: only
# exit-allow when the path canonicalizes AND lands outside the root; on any
# uncertainty fall through to the block list and stay gated. Tools without a
# file path (Bash, mcp__*__bash/exec) also fall through and stay gated.
canonicalize_path() {
  # Canonicalize a path that may not exist yet. Walk up to the nearest
  # EXISTING ancestor directory, resolve it physically (pwd -P follows
  # symlinks), then apply the remaining (non-existent) components logically:
  # "." is skipped and ".." pops a segment. No symlink can exist inside a
  # non-existent path segment, so logical resolution of the tail is sound
  # and matches how the filesystem would resolve it once created. Returns 0
  # with a normalized absolute path; returns 1 only if even the root is not
  # resolvable (then the caller fails safe = gate).
  local p="$1" base tail="" comp canon
  [[ "$p" != /* ]] && p="$PWD/$p"
  base="$p"
  while [[ -n "$base" && "$base" != "/" && ! -d "$base" ]]; do
    tail="${base##*/}/$tail"
    base="${base%/*}"
    [[ -z "$base" ]] && base="/"
  done
  canon="$(cd "$base" 2>/dev/null && pwd -P)" || return 1
  local IFS=/
  for comp in $tail; do
    case "$comp" in
      ""|".") ;;
      "..") canon="${canon%/*}"; [[ -z "$canon" ]] && canon="/" ;;
      *) canon="$canon/$comp" ;;
    esac
  done
  printf '%s' "$canon"
  return 0
}
FILE="$(jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // empty' <<<"$INPUT" 2>/dev/null)"
if [[ -n "$FILE" ]]; then
  if FILE_CANON="$(canonicalize_path "$FILE")"; then
    if [[ "$FILE_CANON" != "$COMPOSER_ROOT" && "$FILE_CANON" != "$COMPOSER_ROOT"/* ]]; then
      exit 0
    fi
  fi
  # Inside the repo, or path could not be canonicalized -> gate (fall through).
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
    emit_deny "DENY (main thread): route Edit/Update/Write via Task(subagent_type=\"coder\"). Native Bash is allowed for inspection and verification."
    ;;
esac

# 5. Pass-through. Emit nothing — Anthropic treats absent JSON + exit 0
#    as implicit allow. (Explicit allow JSON is also valid but noisier.)
exit 0
