#!/usr/bin/env bash
# PostToolUse hook: auto-lint after Edit/Update/Write/NotebookEdit. Fail-soft.
set -u

_composer_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/composer_disabled.lib.sh"
if [ -r "$_composer_lib" ]; then . "$_composer_lib"; else composer_disabled() { return 1; }; fi

if composer_disabled; then
  exit 0
fi

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat || true)"
[[ -z "$INPUT" ]] && exit 0
FILE="$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0
run() { command -v "$1" >/dev/null 2>&1 || return 0; "$@" >&2 2>&1 || printf 'lint-on-save: %s issues on %s\n' "$1" "$FILE" >&2; }
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.vue) run eslint --fix "$FILE" ;;
  *.php)
    if [[ -x vendor/bin/pint ]]; then
      vendor/bin/pint "$FILE" >&2 2>&1 || printf 'lint-on-save: pint issues on %s\n' "$FILE" >&2
    else
      run php-cs-fixer fix "$FILE"
    fi
    ;;
  *.py) run ruff format "$FILE"; run ruff check --fix "$FILE" ;;
  *.rs) run rustfmt "$FILE" ;;
  *.go) run gofmt -w "$FILE" ;;
  *.json|*.md|*.yml|*.yaml|*.css|*.scss|*.html) run prettier --write "$FILE" ;;
esac
exit 0
