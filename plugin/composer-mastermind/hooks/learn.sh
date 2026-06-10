#!/usr/bin/env bash
# Wave 1 F1.11 — passive learning log (T1 self-evolution tier).
# Runs as a Stop hook. Appends correction-shaped user messages from the
# current session transcript into .claude/learnings/<month>.md.
#
# Fail-safe: any missing dependency, missing transcript, or parse error
# results in a silent no-op (exit 0). This MUST NOT block session-end.

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
# events whose content matches the trigger regex, then append new short
# bullets only. Truncate to 400 chars to keep the log scannable.
MATCHES="$(mktemp -t composer_learnings.XXXXXX)" || exit 0
jq -r --arg trig "$TRIGGER" '
  select(.role == "user" or .type == "user")
  | (.content // .message // "") as $raw
  | (if ($raw | type) == "array" then ($raw | map(.text // "") | join(" ")) else ($raw | tostring) end) as $text
  | select($text | test($trig))
  | "- " + ($text | gsub("\\s+"; " ") | .[0:400])
' "$TRANSCRIPT_PATH" 2>/dev/null > "$MATCHES" || {
  rm -f "$MATCHES"
  exit 0
}

NEW_MATCHES="$(mktemp -t composer_learnings_new.XXXXXX)" || {
  rm -f "$MATCHES"
  exit 0
}
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  if [[ ! -f "$OUT" ]] || ! grep -Fxq -- "$line" "$OUT" 2>/dev/null; then
    printf '%s\n' "$line" >> "$NEW_MATCHES"
  fi
done < "$MATCHES"

if [[ -s "$NEW_MATCHES" ]]; then
  {
    printf '\n## Session ended %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat "$NEW_MATCHES"
  } >> "$OUT" 2>/dev/null || true
fi

rm -f "$MATCHES" "$NEW_MATCHES"

exit 0
