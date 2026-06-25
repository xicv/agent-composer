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
