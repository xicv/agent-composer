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
  --base <ref>                   Override branch-diff base ref for review-class modes
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
  ORACLE_PRO_ATTACHMENTS         default: never (inline files; set to auto/bundle for large files)
  ORACLE_PRO_DIFF_BASE           default: auto-detect main/master/develop/origin HEAD
  ORACLE_PRO_MAX_CHANGED_FILES   default: 40
  ORACLE_PRO_MAX_CHANGED_FILE_BYTES default: 120000

Secret file protection:
  --file paths matching known secret patterns (.env, *.pem, *.key, id_rsa, .aws/credentials,
  *secret*, *token*, *credential*, *password*, etc.) are rejected before upload.
  Set ORACLE_PRO_ALLOW_SECRET_FILES=1 to override (use with caution).
USAGE
}

log() { printf '[oracle-pro] %s\n' "$*" >&2; }
warn() { printf '[oracle-pro][warn] %s\n' "$*" >&2; }
die() { printf '[oracle-pro][error] %s\n' "$*" >&2; exit 1; }

node_major() {
  { "$1" --version 2>/dev/null || true; } | sed -E 's/^v?([0-9]+).*/\1/'
}

is_bad_node_major() {
  # Keep this in sync with ORACLE_BAD_NODE_MAJORS in src/cli/doctor.ts.
  case "$1" in
    26) return 0 ;;
    *) return 1 ;;
  esac
}

select_good_node() {
  local node_bin major c version dir
  if node_bin="$(command -v node 2>/dev/null)"; then
    major="$(node_major "$node_bin")"
    if [[ -n "$major" ]] && ! is_bad_node_major "$major"; then
      return 0
    fi
  fi

  shopt -u failglob nullglob

  local candidates=(
    "${ORACLE_NODE_BIN:-}"
    /opt/homebrew/opt/node@24/bin/node
    /usr/local/opt/node@24/bin/node
    "$HOME"/.nvm/versions/node/v24*/bin/node
    "$HOME"/.nvm/versions/node/v25*/bin/node
  )

  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] || continue
    major="$(node_major "$c")"
    [[ -n "$major" ]] || continue
    is_bad_node_major "$major" && continue
    dir="$(dirname "$c")"
    PATH="$dir:$PATH"
    export PATH
    version="$("$c" --version 2>/dev/null || true)"
    log "pinned node $version from $dir (avoids undici setTypeOfService EINVAL)"
    return 0
  done

  warn "no known-good node found; oracle may crash under bad node majors (undici setTypeOfService EINVAL)"
  return 0
}

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
DIFF_BASE="${ORACLE_PRO_DIFF_BASE:-}"

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
    --base) DIFF_BASE="${2:-}"; shift 2 ;;
    --base=*) DIFF_BASE="${1#*=}"; shift ;;
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
select_good_node

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

# Delivery: quick/standard stay inline (fast, no upload-timeout risk); review-class
# modes default to `auto` (inline up to oracle's ~60k-char limit, then upload) so large
# branch diffs are no longer silently truncated. Override with ORACLE_PRO_ATTACHMENTS.
ATTACHMENTS_MODE="${ORACLE_PRO_ATTACHMENTS:-}"
if [[ -z "$ATTACHMENTS_MODE" ]]; then
  case "$MODE" in
    quick|standard) ATTACHMENTS_MODE="never" ;;
    *) ATTACHMENTS_MODE="auto" ;;
  esac
fi

# ChatGPT's Pro model auto-selects "Pro Extended"; its picker no longer exposes a
# separate thinking-time submenu, so --browser-thinking-time errors out with
# "Thinking time: menu not found for pro (requested ...)" and oracle exits 1.
# The flag is redundant for the Pro model, so skip it there. Override with
# ORACLE_PRO_FORCE_THINKING_FLAG=1 if a future oracle/UI restores the menu.
case "$MODEL" in
  *pro*)
    if [[ "${ORACLE_PRO_FORCE_THINKING_FLAG:-0}" != "1" ]]; then
      USE_THINKING_FLAG=0
    fi
    ;;
esac

OUT_DIR="${ORACLE_PRO_OUTPUT_DIR:-.composer/oracle/answers}"
CTX_DIR="${ORACLE_PRO_CONTEXT_DIR:-.composer/oracle/context}"
mkdir -p "$OUT_DIR" "$CTX_DIR"

is_secret_file() {
  # Returns 0 (true) if $1 looks like a secret/credential file we must not upload.
  local p base lc
  p="$1"
  base="${p##*/}"
  lc="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  case "$lc" in
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|*.keystore|*.jks|*.kdbx|*.ppk|id_rsa|id_dsa|id_ecdsa|id_ed25519|.npmrc|.netrc|.pgpass)
      return 0 ;;
    *secret*|*token*|*credential*|*password*)
      return 0 ;;
  esac
  case "$p" in
    */.ssh/*|*/.aws/credentials|*/.gnupg/*)
      return 0 ;;
  esac
  return 1
}

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

detect_diff_base() {
  local b
  if [[ -n "$DIFF_BASE" ]]; then printf '%s' "$DIFF_BASE"; return; fi
  for b in main master develop; do
    git rev-parse --verify --quiet "refs/heads/$b" >/dev/null 2>&1 && { printf '%s' "$b"; return; }
  done
  for b in origin/main origin/master origin/develop; do
    git rev-parse --verify --quiet "refs/remotes/$b" >/dev/null 2>&1 && { printf '%s' "$b"; return; }
  done
  git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's#refs/remotes/##' || true
}

# Populates the global SECRET_EXCLUDES array with :(exclude,literal)<path> pathspecs
# for every changed file that is_secret_file rejects, giving git-diff patch generation
# the SAME denylist coverage as explicit --file uploads. Args: optional git diff range.
build_secret_excludes() {
  SECRET_EXCLUDES=()
  [[ "${ORACLE_PRO_ALLOW_SECRET_FILES:-0}" == "1" ]] && return 0
  local cf
  while IFS= read -r cf; do
    [[ -n "$cf" ]] || continue
    if is_secret_file "$cf"; then SECRET_EXCLUDES+=(":(exclude,literal)$cf"); fi
  done < <(git diff --name-only "$@" 2>/dev/null)
}

if [[ "$AUTO_CONTEXT" -eq 1 ]]; then
  # Authority class B — current policy/context (safe as source-of-truth).
  policy_files=(CLAUDE.md composer.config.json docs/STATUS.md)
  # Authority class C — background/history (risky as source-of-truth; only for planning/research).
  background_files=(README.md AGENTS.md)
  # Project manifest files (dependency intent + language).
  base_files=(package.json pyproject.toml Cargo.toml go.mod)

  # Task-aware attach set: minimal for trivial modes, no stale background for review/debug.
  attach_candidates=()
  case "$MODE" in
    quick|standard)
      attach_candidates=(CLAUDE.md docs/STATUS.md)
      ;;
    review|debug)
      attach_candidates=("${policy_files[@]}" "${base_files[@]}")
      ;;
    deep|plan|research|*)
      attach_candidates=("${policy_files[@]}" "${background_files[@]}" "${base_files[@]}")
      ;;
  esac

  for candidate in "${attach_candidates[@]}"; do
    [[ -f "$candidate" ]] && AUTO_FILES+=("$candidate")
  done

  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    write_context_file "git-status.txt" "git status --short"
    write_context_file "git-diff-stat.txt" "git diff --stat"
    if [[ "$MODE" != "quick" && "$MODE" != "standard" ]]; then
      build_secret_excludes
      wt_patch="$CTX_DIR/$SLUG.git-diff.patch"
      git diff -- . ':(exclude).env' ':(exclude).env.*' ':(exclude)*.pem' ':(exclude)*.key' ':(exclude)*.p12' \
        ${SECRET_EXCLUDES[@]+"${SECRET_EXCLUDES[@]}"} 2>/dev/null \
        | sed -E -e '/(api[_-]?key|secret|token|passwd|password|credential|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)[^a-z0-9]{0,4}[:=]/Id' -e '/bearer[[:space:]]+[a-z0-9._-]{6,}/Id' \
        | head -c 200000 > "$wt_patch" 2>/dev/null || true
      [[ -s "$wt_patch" ]] && AUTO_FILES+=("$wt_patch")
    fi
    # Exact installed top-level deps (package.json shows ranges, not the installed tree).
    if [[ "$MODE" != "quick" && "$MODE" != "standard" ]] && [[ -f package.json ]]; then
      write_context_file "deps.txt" "npm ls --depth=0 2>/dev/null || true"
    fi
    if [[ "$MODE" != "quick" && "$MODE" != "standard" ]]; then
      DIFF_BASE_RESOLVED="$(detect_diff_base)"
      # Defense-in-depth: a git ref can legally contain shell metacharacters
      # (`;`, `$()`, backticks). Since the ref is later interpolated into commands,
      # reject anything outside a safe charset and forbid a leading dash (git option
      # injection) before use.
      if [[ -n "$DIFF_BASE_RESOLVED" && ! "$DIFF_BASE_RESOLVED" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]]; then
        warn "ignoring unsafe diff-base ref (disallowed characters): $DIFF_BASE_RESOLVED"
        DIFF_BASE_RESOLVED=""
      fi
      CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
      if [[ -n "$DIFF_BASE_RESOLVED" && "$CUR_BRANCH" != "$DIFF_BASE_RESOLVED" ]] \
         && git rev-parse --verify --quiet "$DIFF_BASE_RESOLVED" >/dev/null 2>&1; then
        # The committed branch diff vs its base is the REAL review target (working-tree diff
        # is empty once work is committed). This is the primary accuracy fix.
        build_secret_excludes "$DIFF_BASE_RESOLVED...HEAD"
        base_patch="$CTX_DIR/$SLUG.branch-diff.patch"
        git diff "$DIFF_BASE_RESOLVED...HEAD" -- . ':(exclude).env' ':(exclude).env.*' ':(exclude)*.pem' ':(exclude)*.key' ':(exclude)*.p12' \
          ${SECRET_EXCLUDES[@]+"${SECRET_EXCLUDES[@]}"} 2>/dev/null \
          | sed -E -e '/(api[_-]?key|secret|token|passwd|password|credential|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)[^a-z0-9]{0,4}[:=]/Id' -e '/bearer[[:space:]]+[a-z0-9._-]{6,}/Id' \
          | head -c 400000 > "$base_patch" 2>/dev/null || true
        [[ -s "$base_patch" ]] && AUTO_FILES+=("$base_patch")
        write_context_file "branch-diff-stat.txt" "git diff ${DIFF_BASE_RESOLVED}...HEAD --stat"
        # Attach the full content of changed files (enclosing scope for the diff hunks),
        # capped by count and per-file size, secret-filtered.
        while IFS= read -r changed; do
          [[ -n "$changed" && -f "$changed" ]] || continue
          if is_secret_file "$changed" && [[ "${ORACLE_PRO_ALLOW_SECRET_FILES:-0}" != "1" ]]; then continue; fi
          csz="$(wc -c < "$changed" 2>/dev/null | tr -d ' ')"
          [[ -n "$csz" && "$csz" -le "${ORACLE_PRO_MAX_CHANGED_FILE_BYTES:-120000}" ]] || continue
          AUTO_FILES+=("$changed")
        done < <(git diff --name-only "${DIFF_BASE_RESOLVED}...HEAD" -- . ':(exclude).env' ':(exclude).env.*' 2>/dev/null | head -n "${ORACLE_PRO_MAX_CHANGED_FILES:-40}")
      fi
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
add_supported_flag ARGS --browser-attachments "$ATTACHMENTS_MODE"
if [[ "$ATTACHMENTS_MODE" != "never" ]]; then
  add_supported_flag ARGS --browser-bundle-format "${ORACLE_PRO_BUNDLE_FORMAT:-text}"
fi
add_supported_flag ARGS --browser-auto-reattach-delay "${ORACLE_PRO_REATTACH_DELAY:-30s}"
add_supported_flag ARGS --browser-auto-reattach-interval "${ORACLE_PRO_REATTACH_INTERVAL:-2m}"
add_supported_flag ARGS --browser-auto-reattach-timeout "${ORACLE_PRO_REATTACH_TIMEOUT:-2m}"
add_supported_flag ARGS --heartbeat "${ORACLE_PRO_HEARTBEAT:-30}"

# Validate + collect the exact attachment set (user files first, then auto context).
ATTACH=()
for f in "${FILES[@]}"; do
  [[ -n "$f" ]] || continue
  if is_secret_file "$f" && [[ "${ORACLE_PRO_ALLOW_SECRET_FILES:-0}" != "1" ]]; then
    die "refusing to upload potential secret file: $f (matches secret denylist). Rename/relocate it, or set ORACLE_PRO_ALLOW_SECRET_FILES=1 to override."
  fi
  ATTACH+=("$f")
done
for f in "${AUTO_FILES[@]}"; do
  [[ -n "$f" ]] && ATTACH+=("$f")
done

# Snapshot manifest: authoritative identity of the repo state this call may discuss.
# Lets the model (and us) detect drift between turns and bounds it to current disk state.
captured_at="$(date +%Y-%m-%dT%H:%M:%S%z)"
repo_root="$(pwd)"
git_branch="n/a"; git_head="n/a"; dirty="false"; status_hash="n/a"; diff_hash="n/a"
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
  git_head="$(git rev-parse HEAD 2>/dev/null || echo n/a)"
  [[ -n "$(git status --porcelain 2>/dev/null)" ]] && dirty="true"
  status_hash="$(git status --short 2>/dev/null | shasum -a 256 2>/dev/null | awk '{print $1}')"
  diff_hash="$(git diff 2>/dev/null | shasum -a 256 2>/dev/null | awk '{print $1}')"
fi
[[ -n "$status_hash" ]] || status_hash="n/a"
[[ -n "$diff_hash" ]] || diff_hash="n/a"
node_ver="$(node --version 2>/dev/null || echo n/a)"
npm_ver="$(npm --version 2>/dev/null || echo n/a)"
os_ver="$(uname -sr 2>/dev/null || echo n/a)"
arch_ver="$(uname -m 2>/dev/null || echo n/a)"
short_head="${git_head:0:12}"
repo_state_hash="$(printf '%s' "${git_head}${status_hash}${diff_hash}${node_ver}${npm_ver}" | shasum -a 256 2>/dev/null | awk '{print $1}')"
[[ -n "$repo_state_hash" ]] || repo_state_hash="n/a"
snapshot_id="${SLUG}-${short_head}-${repo_state_hash:0:8}"

MANIFEST_PATH="$CTX_DIR/$SLUG.manifest.json"
# JSON-escape a string value (backslash and double-quote only; inputs are paths/hashes/versions).
json_escape() { printf '%s' "${1-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
{
  printf '{\n'
  printf '  "snapshotId": "%s",\n' "$(json_escape "$snapshot_id")"
  printf '  "capturedAt": "%s",\n' "$(json_escape "$captured_at")"
  printf '  "repoRoot": "%s",\n' "$(json_escape "$repo_root")"
  printf '  "branch": "%s",\n' "$(json_escape "$git_branch")"
  printf '  "head": "%s",\n' "$(json_escape "$git_head")"
  printf '  "dirty": %s,\n' "$dirty"
  printf '  "gitStatusHash": "%s",\n' "$(json_escape "$status_hash")"
  printf '  "diffHash": "%s",\n' "$(json_escape "$diff_hash")"
  printf '  "repoStateHash": "%s",\n' "$(json_escape "$repo_state_hash")"
  printf '  "mode": "%s",\n' "$(json_escape "$MODE")"
  printf '  "runtime": { "node": "%s", "npm": "%s", "os": "%s", "arch": "%s" },\n' \
    "$(json_escape "$node_ver")" "$(json_escape "$npm_ver")" "$(json_escape "$os_ver")" "$(json_escape "$arch_ver")"
  printf '  "attachments": [\n'
  manifest_n=${#ATTACH[@]}
  manifest_i=0
  for f in "${ATTACH[@]}"; do
    manifest_i=$((manifest_i + 1))
    sha="$(shasum -a 256 "$f" 2>/dev/null | awk '{print $1}')"
    bytes="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
    sep=","
    [[ "$manifest_i" -eq "$manifest_n" ]] && sep=""
    printf '    { "path": "%s", "sha256": "%s", "bytes": %s }%s\n' \
      "$(json_escape "$f")" "${sha:-}" "${bytes:-0}" "$sep"
  done
  printf '  ]\n'
  printf '}\n'
} > "$MANIFEST_PATH" 2>/dev/null || warn "manifest generation failed (continuing without manifest)"
[[ -f "$MANIFEST_PATH" ]] && ATTACH+=("$MANIFEST_PATH")

# CONTEXT CONTRACT: bound the model to this snapshot; defeat stale memory/attachments.
CONTRACT="$(cat <<EOF
CONTEXT CONTRACT
Authoritative snapshot: ${snapshot_id}
Captured at: ${captured_at}
Branch / HEAD: ${git_branch} / ${git_head}
Dirty tree: ${dirty}
Repo-state hash: ${repo_state_hash}
Runtime: node=${node_ver} npm=${npm_ver} os=${os_ver} arch=${arch_ver}
Task: ${MODE}
Authority order:
  A. Live source-of-truth: ${SLUG}.manifest.json, ${SLUG}.git-status.txt, ${SLUG}.git-diff.patch, ${SLUG}.branch-diff.patch, ${SLUG}.deps.txt, changed source files, targeted source/tests
  B. Current policy/context: CLAUDE.md, composer.config.json, docs/STATUS.md, relevant ADRs
  C. Background/history: README.md, AGENTS.md
Rules:
- Treat class A as authoritative for the local repo. If A conflicts with B or C, A wins.
- The attached files are the ONLY authoritative source for any code-level claim. Any description of the code in the TASK below is a hint about what to review, NOT source of truth — never treat prose as code.
- Ignore prior chat memory, project memory, and earlier attachments if they conflict with this snapshot.
- For each substantive claim, tag it [attached], [runtime], [web], or [inference].
- Cite attached claims with file path and line span.
- For EACH finding: first quote the exact supporting line(s) verbatim from an attached file as `path:line`, THEN state the finding. If you cannot quote supporting lines from the attached files, label it "INSUFFICIENT EVIDENCE — not in provided context" and do not raise it as a blocker.
- Do not infer a bug from an absent detail; absence of code in the attachments means unknown, not broken.
- For current API/library claims not proven by attached files, verify on the web against primary docs.
- If evidence is insufficient, say: "unknown from provided context".
EOF
)"
PROMPT="${CONTRACT}

${PROMPT}"

# Emit all attachments (incl. the manifest) as --file inputs.
for f in "${ATTACH[@]}"; do
  [[ -n "$f" ]] && ARGS+=(--file "$f")
done

log "oracle version: ${ORACLE_VERSION:-unknown}"
log "mode=$MODE model=$MODEL thinking=$THINKING research=$RESEARCH_MODE output=$OUT_FILE"
log "files: user=${#FILES[@]} auto=${#AUTO_FILES[@]} total=${#ATTACH[@]} snapshot=${snapshot_id}"

oracle "${ARGS[@]}" -p "$PROMPT"

# Maintain a stable latest file for downstream Codex/Composer commands.
if [[ -f "$OUT_FILE" ]]; then
  cp "$OUT_FILE" "$OUT_DIR/latest.md"
  printf '%s\n' "$OUT_FILE"
fi
