#!/usr/bin/env bash
set -euo pipefail

MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-3600}"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/codex-cua-reaper.log"

patterns=(
  "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp"
  "cua_node/bin/node_repl"
  "codex app-server"
)

mkdir -p "$LOG_DIR"

scanned=0
killed_pids=()

for pattern in "${patterns[@]}"; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    scanned=$((scanned + 1))

    cmd="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$cmd" == *"/Applications/Codex.app/"* ]] && continue

    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"

    [[ -n "$ppid" && -n "$etimes" ]] || continue

    if [[ "$ppid" == "1" || "$etimes" -gt "$MAX_AGE_SECONDS" ]]; then
      killed_pids+=("$pid")
    fi
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
done

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

printf '%s scanned=%s killed=%s pids=[%s]\n' "$timestamp" "$scanned" "$killed" "$pids" >> "$LOG_FILE"
