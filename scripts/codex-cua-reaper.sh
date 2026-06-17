#!/usr/bin/env bash
set -euo pipefail

MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-300}"
BROKER_ORPHAN_GRACE_SECONDS="${BROKER_ORPHAN_GRACE_SECONDS:-60}"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/codex-cua-reaper.log"
REGISTRY_DIR="${COMPOSER_REAPER_REGISTRY_DIR:-${TMPDIR:-/tmp}/composer-cua-reaper-watchdogs}"
MODE="${1:---spawn-cycle}"

patterns=(
  "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp"
  "cua_node/bin/node_repl"
  "codex app-server"
)

orphan_only_patterns=(
  "scripts/app-server-broker.mjs"
)

mkdir -p "$LOG_DIR"
mkdir -p "$REGISTRY_DIR"
shopt -s nullglob

scanned=0
killed_pids=()
killed_reasons=()

pid_is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

register_watchdog() {
  local pid="${1:-}"
  local label="${2:-spawn}"
  local max_age="${3:-$MAX_AGE_SECONDS}"
  case "$pid" in ''|*[!0-9]*) exit 0 ;; esac
  case "$max_age" in ''|*[!0-9]*) max_age="$MAX_AGE_SECONDS" ;; esac

  local record="$REGISTRY_DIR/$pid.watchdog"
  {
    printf 'pid=%s\n' "$pid"
    printf 'label=%s\n' "$label"
    printf 'max_age_seconds=%s\n' "$max_age"
    printf 'registered_at=%s\n' "$(date +%s)"
  } > "$record.$$"
  mv "$record.$$" "$record"
}

record_kill() {
  local pid="$1"
  local reason="$2"
  killed_pids+=("$pid")
  killed_reasons+=("$pid:$reason")
}

read_record_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null || true
}

scan_registered_watchdogs() {
  local record pid label max_age registered_at now record_age ppid etimes reason
  for record in "$REGISTRY_DIR"/*.watchdog; do
    [[ -f "$record" ]] || continue
    scanned=$((scanned + 1))
    pid="$(read_record_value "$record" pid)"
    label="$(read_record_value "$record" label)"
    max_age="$(read_record_value "$record" max_age_seconds)"
    registered_at="$(read_record_value "$record" registered_at)"
    case "$pid" in ''|*[!0-9]*) rm -f "$record"; continue ;; esac
    case "$max_age" in ''|*[!0-9]*) max_age="$MAX_AGE_SECONDS" ;; esac
    case "$registered_at" in ''|*[!0-9]*) registered_at=0 ;; esac

    if ! pid_is_alive "$pid"; then
      rm -f "$record"
      continue
    fi

    now="$(date +%s)"
    record_age=$(( now - registered_at ))
    [[ "$record_age" -ge 0 ]] || record_age=0
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"

    reason=""
    if [[ "$ppid" == "1" ]]; then
      reason="registered_orphan"
    elif [[ "$record_age" -ge "$max_age" ]]; then
      reason="registered_max_age"
    elif [[ "$etimes" =~ ^[0-9]+$ && "$etimes" -ge "$max_age" ]]; then
      reason="registered_max_age"
    fi

    if [[ -n "$reason" ]]; then
      record_kill "$pid" "$reason:${label:-spawn}"
      rm -f "$record"
    fi
  done
}

case "$MODE" in
  --register)
    shift
    register_watchdog "$@"
    exit 0
    ;;
  --spawn-cycle|--once)
    ;;
  *)
    echo "usage: codex-cua-reaper.sh [--spawn-cycle|--once|--register <pid> [label] [max_age_seconds]]" >&2
    exit 2
    ;;
esac

for pattern in "${patterns[@]}"; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    scanned=$((scanned + 1))

    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"

    [[ -n "$ppid" && -n "$etimes" ]] || continue

    if [[ "$ppid" == "1" || "$etimes" -gt "$MAX_AGE_SECONDS" ]]; then
      record_kill "$pid" "pattern:${pattern}"
    fi
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
done

for pattern in "${orphan_only_patterns[@]}"; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    scanned=$((scanned + 1))

    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"

    [[ -n "$ppid" && -n "$etimes" ]] || continue

    if [[ "$ppid" == "1" && "$etimes" -gt "$BROKER_ORPHAN_GRACE_SECONDS" ]]; then
      record_kill "$pid" "orphan_pattern:${pattern}"
    fi
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
done

scan_registered_watchdogs

if ((${#killed_pids[@]} > 0)); then
  for pid in "${killed_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  sleep 3

  for pid in "${killed_pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    kill -KILL "$pid" 2>/dev/null || true
  done
fi

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
killed="${#killed_pids[@]}"
pids="${killed_pids[*]:-}"
reasons="${killed_reasons[*]:-}"

printf '%s scanned=%s killed=%s pids=[%s] reasons=[%s]\n' "$timestamp" "$scanned" "$killed" "$pids" "$reasons" >> "$LOG_FILE"
