#!/usr/bin/env bash
# Wave 1 F1.11 — passive learning log (T1 self-evolution tier).
# Runs as a Stop hook. Appends correction-shaped user messages from the
# current session transcript into .claude/learnings/<month>.md.
#
# Fail-safe: any missing dependency, missing transcript, or parse error
# results in a silent no-op (exit 0). This MUST NOT block session-end.

set -u

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LEARN_DIR="$PROJECT_DIR/.claude/learnings"
MONTH="$(date +%Y-%m)"
OUT="$LEARN_DIR/${MONTH}.md"

# Read JSON envelope from stdin (Anthropic Stop hook contract).
INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TRANSCRIPT_PATH="$(jq -r '.transcript_path // empty' <<<"$INPUT" 2>/dev/null)"
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  exit 0
fi

mkdir -p "$LEARN_DIR" 2>/dev/null || exit 0

# Trigger words for "correction-shaped" user messages.
# Conservative regex; expand from real data over time.
TRIGGER='(?i)\b(no|don.t|do not|wrong|stop|actually|instead|never|please don.t)\b'

# Anthropic transcripts are JSONL (one event per line). Filter user-role
# events whose content matches the trigger regex, then append a short
# bullet per match. Truncate to 240 chars to keep the log scannable.
{
  printf '\n## Session ended %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -r --arg trig "$TRIGGER" '
    select(.role == "user" or .type == "user")
    | (.content // .message // "") as $raw
    | (if ($raw | type) == "array" then ($raw | map(.text // "") | join(" ")) else ($raw | tostring) end) as $text
    | select($text | test($trig))
    | "- " + ($text | gsub("\\s+"; " ") | .[0:240])
  ' "$TRANSCRIPT_PATH" 2>/dev/null
} >> "$OUT" 2>/dev/null || true

exit 0
