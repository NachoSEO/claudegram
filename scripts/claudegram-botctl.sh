#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${ROOT_DIR}/claudegram.dev.log"

MODE="${MODE:-dev}"
ACTION="${1:-status}"
if [[ "${ACTION}" == "dev" || "${ACTION}" == "prod" ]]; then
  MODE="${ACTION}"
  ACTION="${2:-status}"
fi

DEV_PATTERNS=(
  "tsx watch src/index.ts"
  "node .*claudegram/node_modules/.bin/tsx"
  "tsx/dist/loader"
  "npm run dev"
  "npm exec tsx watch src/index.ts"
)

PROD_PATTERNS=(
  "node .*dist/index.js"
  "npm start"
)

ALL_PATTERNS=(
  "${DEV_PATTERNS[@]}"
  "${PROD_PATTERNS[@]}"
)

function list_pids_for_patterns() {
  local -a patterns=("$@")
  local pids=()
  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] && pids+=("${pid}")
    done < <(pgrep -f "${pattern}" || true)
  done

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 1
  fi

  printf "%s\n" "${pids[@]}" | sort -u
}

function list_pids() {
  local -a patterns
  if [[ "${MODE}" == "prod" ]]; then
    patterns=("${PROD_PATTERNS[@]}")
  else
    patterns=("${DEV_PATTERNS[@]}")
  fi
  list_pids_for_patterns "${patterns[@]}"
}

function list_pids_all() {
  list_pids_for_patterns "${ALL_PATTERNS[@]}"
}

function status() {
  if pids=$(list_pids 2>/dev/null); then
    echo "Claudegram (${MODE}) is running:"
    echo "${pids}" | sed 's/^/  PID: /'
    return 0
  fi

  echo "Claudegram (${MODE}) is not running."
  return 1
}

function wait_for_stop() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if ! list_pids >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function wait_for_stop_all() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if ! list_pids_all >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function wait_for_start() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if list_pids >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function stop() {
  if ! pids=$(list_pids 2>/dev/null); then
    echo "No Claudegram (${MODE}) process found."
    return 0
  fi

  echo "Stopping Claudegram (${MODE})..."
  echo "${pids}" | xargs -r kill -TERM
  sleep 1

  if pids_after=$(list_pids 2>/dev/null); then
    echo "Force killing remaining PIDs:"
    echo "${pids_after}" | sed 's/^/  PID: /'
    echo "${pids_after}" | xargs -r kill -KILL
  fi

  if ! wait_for_stop 10; then
    echo "Warning: Claudegram (${MODE}) did not fully stop within timeout."
  fi
}

function stop_all() {
  if ! pids=$(list_pids_all 2>/dev/null); then
    echo "No Claudegram processes found."
    return 0
  fi

  echo "Stopping all Claudegram processes..."
  echo "${pids}" | xargs -r kill -TERM
  sleep 1

  if pids_after=$(list_pids_all 2>/dev/null); then
    echo "Force killing remaining PIDs:"
    echo "${pids_after}" | sed 's/^/  PID: /'
    echo "${pids_after}" | xargs -r kill -KILL
  fi

  if ! wait_for_stop_all 10; then
    echo "Warning: Claudegram processes did not fully stop within timeout."
  fi
}

function start() {
  if status >/dev/null 2>&1; then
    echo "Claudegram (${MODE}) already running."
    status
    return 0
  fi

  echo "Starting Claudegram (${MODE})..."
  cd "${ROOT_DIR}"
  if [[ "${MODE}" == "prod" ]]; then
    nohup npm start > "${LOG_FILE}" 2>&1 &
  else
    nohup npm run dev > "${LOG_FILE}" 2>&1 &
  fi

  if ! wait_for_start 10; then
    echo "Warning: Claudegram (${MODE}) did not appear to start."
  fi
  status || true
  echo "Log: ${LOG_FILE}"
}

function recover() {
  stop_all
  start
}

case "${ACTION}" in
  status)
    status
    ;;
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop_all
    start
    ;;
  recover)
    recover
    ;;
  stop-all)
    stop_all
    ;;
  log)
    tail -n 50 "${LOG_FILE}"
    ;;
  *)
    echo "Usage: $(basename "$0") [dev|prod] {status|start|stop|stop-all|restart|recover|log}"
    exit 1
    ;;
esac
