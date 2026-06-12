#!/usr/bin/env bash
set -euo pipefail

# oracle-pro-safe.sh
# Safe ChatGPT Pro browser adapter for steipete/oracle.
# Key design: never assume optional/hidden Oracle flags. Probe them with a dry-run first,
# then include only flags accepted by the installed local binary.

usage() {
  cat <<'USAGE'
Usage:
  scripts/oracle-pro-safe.sh [options] -- "prompt"
  scripts/oracle-pro-safe.sh [options] -p "prompt"

Options:
  --mode <auto|quick|standard|deep|plan|review|debug|research>
  --file <path-or-glob>          Repeatable; passed to oracle --file
  --slug <slug>                  Output slug prefix
  --dry-run                      Run Oracle dry-run/preview only
  --no-context                   Do not auto-attach lightweight repo context
  --no-thinking-flag             Do not pass --browser-thinking-time even if supported
  --no-manual-login              Do not pass --browser-manual-login even if supported
  --model <model>                Override selected Oracle model
  --thinking <level>             Override browser thinking level: light|standard|extended|heavy
  --research deep|off            Override browser research mode
  -p, --prompt <prompt>          Prompt text
  -h, --help

Environment overrides:
  ORACLE_PRO_QUICK_MODEL         default: gpt-5.2-instant
  ORACLE_PRO_STANDARD_MODEL      default: gpt-5.5
  ORACLE_PRO_DEEP_MODEL          default: gpt-5.5-pro
  ORACLE_PRO_QUICK_THINKING      default: light
  ORACLE_PRO_STANDARD_THINKING   default: standard
  ORACLE_PRO_DEEP_THINKING       default: extended
  ORACLE_PRO_BROWSER_STRATEGY    default: select
  ORACLE_PRO_OUTPUT_DIR          default: .composer/oracle/answers
  ORACLE_PRO_CONTEXT_DIR         default: .composer/oracle/context
  ORACLE_PRO_TIMEOUT             default: 20m
  ORACLE_PRO_INPUT_TIMEOUT       default: 60s
  ORACLE_PRO_REATTACH_DELAY      default: 30s
  ORACLE_PRO_REATTACH_INTERVAL   default: 2m
  ORACLE_PRO_REATTACH_TIMEOUT    default: 2m
USAGE
}

log() { printf '[oracle-pro] %s\n' "$*" >&2; }
warn() { printf '[oracle-pro][warn] %s\n' "$*" >&2; }
die() { printf '[oracle-pro][error] %s\n' "$*" >&2; exit 1; }

MODE="auto"
PROMPT=""
SLUG=""
DRY_RUN=0
AUTO_CONTEXT=1
USE_THINKING_FLAG=1
USE_MANUAL_LOGIN=1
MODEL_OVERRIDE=""
THINKING_OVERRIDE=""
RESEARCH_OVERRIDE=""
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --file|-f) FILES+=("${2:-}"); shift 2 ;;
    --file=*) FILES+=("${1#*=}"); shift ;;
    --slug) SLUG="${2:-}"; shift 2 ;;
    --slug=*) SLUG="${1#*=}"; shift ;;
    --dry-run|--preview) DRY_RUN=1; shift ;;
    --no-context) AUTO_CONTEXT=0; shift ;;
    --no-thinking-flag) USE_THINKING_FLAG=0; shift ;;
    --no-manual-login) USE_MANUAL_LOGIN=0; shift ;;
    --model|-m) MODEL_OVERRIDE="${2:-}"; shift 2 ;;
    --model=*) MODEL_OVERRIDE="${1#*=}"; shift ;;
    --thinking) THINKING_OVERRIDE="${2:-}"; shift 2 ;;
    --thinking=*) THINKING_OVERRIDE="${1#*=}"; shift ;;
    --research) RESEARCH_OVERRIDE="${2:-}"; shift 2 ;;
    --research=*) RESEARCH_OVERRIDE="${1#*=}"; shift ;;
    -p|--prompt) PROMPT="${2:-}"; shift 2 ;;
    --prompt=*) PROMPT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; PROMPT="${*:-}"; break ;;
    *)
      if [[ -z "$PROMPT" ]]; then PROMPT="$1"; else PROMPT="$PROMPT $1"; fi
      shift
      ;;
  esac
done

[[ -n "$PROMPT" ]] || die "prompt is required"
command -v oracle >/dev/null 2>&1 || die "oracle not found in PATH"

case "$MODE" in
  auto|quick|standard|deep|plan|review|debug|research) ;;
  *) die "unknown mode: $MODE" ;;
esac

classify_mode() {
  local text_lc
  text_lc="$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')"
  case "$text_lc" in
    *'[oracle:quick]'*) echo quick; return ;;
    *'[oracle:standard]'*) echo standard; return ;;
    *'[oracle:deep]'*|*'[oracle:plan]'*) echo deep; return ;;
    *'[oracle:review]'*) echo review; return ;;
    *'[oracle:debug]'*) echo debug; return ;;
    *'[oracle:research]'*) echo research; return ;;
  esac
  if [[ ${#PROMPT} -gt 2500 ]]; then echo deep; return; fi
  if [[ "$text_lc" =~ (architecture|architectural|design|plan|planning|proposal|migration|refactor|roadmap|tradeoff|trade-off|spec|handoff|implementation[[:space:]]+plan) ]]; then echo deep; return; fi
  if [[ "$text_lc" =~ (review|audit|regression|security|compatibility|api[[:space:]]+break|edge[[:space:]]+case|risk) ]]; then echo review; return; fi
  if [[ "$text_lc" =~ (debug|root[ -]?cause|failing|failure|flaky|bug|stack[[:space:]]+trace|exception|crash|deadlock|race) ]]; then echo debug; return; fi
  if [[ "$text_lc" =~ (research|compare[[:space:]]+options|survey|citations|latest|web) ]]; then echo research; return; fi
  if [[ "$text_lc" =~ (quick|simple|small|syntax|command|explain) ]]; then echo quick; return; fi
  echo standard
}

if [[ "$MODE" == "auto" ]]; then
  MODE="$(classify_mode)"
fi

# Dispatch table. Model is the primary selector. Thinking flag is additive when the local binary supports it.
QUICK_MODEL="${ORACLE_PRO_QUICK_MODEL:-gpt-5.2-instant}"
STANDARD_MODEL="${ORACLE_PRO_STANDARD_MODEL:-gpt-5.5}"
DEEP_MODEL="${ORACLE_PRO_DEEP_MODEL:-gpt-5.5-pro}"
QUICK_THINKING="${ORACLE_PRO_QUICK_THINKING:-light}"
STANDARD_THINKING="${ORACLE_PRO_STANDARD_THINKING:-standard}"
DEEP_THINKING="${ORACLE_PRO_DEEP_THINKING:-extended}"
RESEARCH_MODE="off"
DEFAULT_STRATEGY="select"

case "$MODE" in
  quick) MODEL="$QUICK_MODEL"; THINKING="$QUICK_THINKING"; DEFAULT_STRATEGY="current" ;;
  standard) MODEL="$STANDARD_MODEL"; THINKING="$STANDARD_THINKING"; DEFAULT_STRATEGY="current" ;;
  deep|plan|review|debug) MODEL="$DEEP_MODEL"; THINKING="$DEEP_THINKING"; DEFAULT_STRATEGY="select" ;;
  research) MODEL="$DEEP_MODEL"; THINKING="$DEEP_THINKING"; RESEARCH_MODE="deep"; DEFAULT_STRATEGY="select" ;;
esac

[[ -z "$MODEL_OVERRIDE" ]] || MODEL="$MODEL_OVERRIDE"
[[ -z "$THINKING_OVERRIDE" ]] || THINKING="$THINKING_OVERRIDE"
[[ -z "$RESEARCH_OVERRIDE" ]] || RESEARCH_MODE="$RESEARCH_OVERRIDE"

OUT_DIR="${ORACLE_PRO_OUTPUT_DIR:-.composer/oracle/answers}"
CTX_DIR="${ORACLE_PRO_CONTEXT_DIR:-.composer/oracle/context}"
mkdir -p "$OUT_DIR" "$CTX_DIR"

safe_slug() {
  local s="$1"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+|-+$//g; s/-+/-/g')"
  [[ -n "$s" ]] || s="oracle"
  printf '%s' "${s:0:80}"
}

if [[ -z "$SLUG" ]]; then
  SLUG="$(date +%Y%m%d-%H%M%S)-${MODE}"
else
  SLUG="$(date +%Y%m%d-%H%M%S)-$(safe_slug "$SLUG")"
fi
OUT_FILE="$OUT_DIR/$SLUG.md"

# Probe support for optional flags. A dry-run should parse options without touching Chrome.
# Cache per-version-ish in the context dir to avoid repeated probes.
ORACLE_VERSION="$(oracle --version 2>/dev/null | head -1 | tr -d '\r' || true)"
CACHE_DIR="$CTX_DIR/.flag-cache"
mkdir -p "$CACHE_DIR"
cache_key="$(printf '%s' "$(command -v oracle)::${ORACLE_VERSION}" | shasum 2>/dev/null | awk '{print $1}')"
[[ -n "$cache_key" ]] || cache_key="default"

supports_option() {
  local flag="$1"
  local value="${2-}"
  local key="$CACHE_DIR/${cache_key}.$(printf '%s' "$flag" | tr -c 'a-zA-Z0-9_' '_')"
  if [[ -f "$key" ]]; then
    [[ "$(cat "$key")" == "yes" ]]
    return
  fi
  local args=(--engine browser --dry-run summary -p "oracle flag probe")
  if [[ -n "$value" ]]; then args+=("$flag" "$value"); else args+=("$flag"); fi
  if oracle "${args[@]}" >/dev/null 2>"$key.err"; then
    printf 'yes' > "$key"
    return 0
  fi
  if grep -qiE 'unknown option|unknown argument|invalid option' "$key.err" 2>/dev/null; then
    printf 'no' > "$key"
    return 1
  fi
  # Conservative: if dry-run failed for some non-parse reason, do not use the optional flag.
  printf 'no' > "$key"
  return 1
}

add_supported_flag() {
  # $1 is the target array name (historically a nameref); all callers use ARGS,
  # so append to ARGS directly to stay compatible with Bash 3.2 (no `local -n`).
  local flag="$2"
  local value="${3-}"
  if supports_option "$flag" "$value"; then
    if [[ -n "$value" ]]; then ARGS+=("$flag" "$value"); else ARGS+=("$flag"); fi
  else
    warn "installed oracle does not accept $flag; skipping"
  fi
}

# Auto context: small, local, non-secret evidence that helps ChatGPT plan/review without dumping the repo.
AUTO_FILES=()
write_context_file() {
  local name="$1"
  local content_cmd="$2"
  local path="$CTX_DIR/$SLUG.$name"
  bash -lc "$content_cmd" > "$path" 2>/dev/null || true
  if [[ -s "$path" ]]; then AUTO_FILES+=("$path"); fi
}

if [[ "$AUTO_CONTEXT" -eq 1 ]]; then
  for candidate in AGENTS.md CLAUDE.md README.md package.json composer.config.json pyproject.toml Cargo.toml go.mod; do
    [[ -f "$candidate" ]] && AUTO_FILES+=("$candidate")
  done
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    write_context_file "git-status.txt" "git status --short"
    write_context_file "git-diff-stat.txt" "git diff --stat"
    if [[ "$MODE" != "quick" && "$MODE" != "standard" ]]; then
      write_context_file "git-diff.patch" "git diff -- . ':(exclude).env' ':(exclude).env.*' ':(exclude)*.pem' ':(exclude)*.key' ':(exclude)*.p12' | sed -E -e '/(api[_-]?key|secret|token|passwd|password|credential|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)[^a-z0-9]{0,4}[:=]/Id' -e '/bearer[[:space:]]+[a-z0-9._-]{6,}/Id' | head -c 200000"
    fi
  fi
fi

ARGS=(--engine browser -m "$MODEL" --write-output "$OUT_FILE")

if [[ "$DRY_RUN" -eq 1 ]]; then
  ARGS+=(--dry-run summary)
fi

# Official v0.13.0 accepts these, but many are hidden from --help; still probe to survive forks/older installs.
add_supported_flag ARGS --browser-model-strategy "${ORACLE_PRO_BROWSER_STRATEGY:-$DEFAULT_STRATEGY}"

if [[ "$USE_THINKING_FLAG" -eq 1 ]]; then
  add_supported_flag ARGS --browser-thinking-time "$THINKING"
fi

if [[ "$RESEARCH_MODE" == "deep" ]]; then
  add_supported_flag ARGS --browser-research deep
fi

if [[ "$USE_MANUAL_LOGIN" -eq 1 ]]; then
  add_supported_flag ARGS --browser-manual-login
fi

add_supported_flag ARGS --browser-timeout "${ORACLE_PRO_TIMEOUT:-20m}"
add_supported_flag ARGS --browser-input-timeout "${ORACLE_PRO_INPUT_TIMEOUT:-60s}"
add_supported_flag ARGS --browser-auto-reattach-delay "${ORACLE_PRO_REATTACH_DELAY:-30s}"
add_supported_flag ARGS --browser-auto-reattach-interval "${ORACLE_PRO_REATTACH_INTERVAL:-2m}"
add_supported_flag ARGS --browser-auto-reattach-timeout "${ORACLE_PRO_REATTACH_TIMEOUT:-2m}"
add_supported_flag ARGS --heartbeat "${ORACLE_PRO_HEARTBEAT:-30}"

# File inputs. Pass user files first, then auto context.
for f in "${FILES[@]}"; do
  [[ -n "$f" ]] && ARGS+=(--file "$f")
done
for f in "${AUTO_FILES[@]}"; do
  [[ -n "$f" ]] && ARGS+=(--file "$f")
done

log "oracle version: ${ORACLE_VERSION:-unknown}"
log "mode=$MODE model=$MODEL thinking=$THINKING research=$RESEARCH_MODE output=$OUT_FILE"
log "files: user=${#FILES[@]} auto=${#AUTO_FILES[@]}"

oracle "${ARGS[@]}" -p "$PROMPT"

# Maintain a stable latest file for downstream Codex/Composer commands.
if [[ -f "$OUT_FILE" ]]; then
  cp "$OUT_FILE" "$OUT_DIR/latest.md"
  printf '%s\n' "$OUT_FILE"
fi
