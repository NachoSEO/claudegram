#!/usr/bin/env bash
# rotate-logs.sh — Rotate a log file on service restart.
#
# Called via ExecStartPre= in the systemd unit so each service session
# gets a fresh log file. Old logs are numbered .1 (newest) through .N
# (oldest). When MAX_ROTATED is exceeded the oldest file is deleted.
#
# Usage: rotate-logs.sh <logfile> [max_rotated]
#   logfile       — path to the active log (e.g. logs/discord.prod.log)
#   max_rotated   — number of rotated copies to keep (default 10)

set -euo pipefail

LOG_FILE="${1:?Usage: rotate-logs.sh <logfile> [max_rotated]}"
MAX_ROTATED="${2:-10}"

# Nothing to rotate if the log doesn't exist or is empty
[[ -s "$LOG_FILE" ]] || exit 0

# Shift existing rotated logs up by 1 (.9→.10, .8→.9, … .1→.2)
for (( i = MAX_ROTATED; i >= 1; i-- )); do
  src="${LOG_FILE}.${i}"
  dst="${LOG_FILE}.$(( i + 1 ))"
  [[ -f "$src" ]] && mv "$src" "$dst"
done

# Current log becomes .1
mv "$LOG_FILE" "${LOG_FILE}.1"

# Delete anything beyond MAX_ROTATED
beyond="${LOG_FILE}.$(( MAX_ROTATED + 1 ))"
[[ -f "$beyond" ]] && rm -f "$beyond"

echo "[rotate-logs] Rotated $(wc -l < "${LOG_FILE}.1") lines → ${LOG_FILE}.1 (keeping last ${MAX_ROTATED})"
