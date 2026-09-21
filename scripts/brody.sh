#!/usr/bin/env bash
# Brody launcher.   brody start | stop | restart | status | logs | open   (start and restart open the browser; add --no-open to skip)
# Builds the app when needed, runs it in the background, waits until it is healthy and opens it in your browser.

set -uo pipefail

# Resolve the repository even when this script is run through a symlink on PATH.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
cd "$ROOT" || exit 1

PORT="${PORT:-3003}"
HOST_NAME="${BRODY_HOST:-brody}"
URL="http://$HOST_NAME:$PORT"
mkdir -p data
PID_FILE="data/brody.pid"
LOG_FILE="data/brody.log"

say() { printf '%s\n' "$*"; }
fail() { printf 'brody: %s\n' "$*" >&2; exit 1; }

listener_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

healthy() {
  # The host check only answers to $HOST_NAME, so send that name explicitly; this works before /etc/hosts is set up.
  curl -fsS -m 3 -H "Host: $HOST_NAME" "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1
}

needs_build() {
  [ ! -f .next/BUILD_ID ] && return 0
  [ -n "$(find src drizzle public package.json package-lock.json next.config.ts -newer .next/BUILD_ID -print -quit 2>/dev/null)" ] && return 0
  return 1
}

# Opens Brody in the default browser once it is ready. Skipped with --no-open or BRODY_OPEN=0; BRODY_BROWSER overrides the opener.
open_browser() {
  [ "${BRODY_OPEN:-1}" = "0" ] && return 0
  if ! name_resolves; then
    say "Not opening the browser: '$HOST_NAME' does not resolve yet (see the note above), so the page would not load."
    return 0
  fi
  local opener="${BRODY_BROWSER:-}"
  if [ -z "$opener" ]; then
    if command -v open >/dev/null 2>&1; then opener="open"
    elif command -v xdg-open >/dev/null 2>&1; then opener="xdg-open"
    elif command -v wslview >/dev/null 2>&1; then opener="wslview"
    else say "Open $URL in your browser."; return 0; fi
  fi
  # Load the home page once so the browser opens on a page that is already warm.
  curl -fsS -m 10 -H "Host: $HOST_NAME" "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  "$opener" "$URL" >/dev/null 2>&1 || say "Could not open a browser automatically. Open $URL yourself."
}

name_resolves() { dscacheutil -q host -a name "$HOST_NAME" 2>/dev/null | grep -q "127.0.0.1" || grep -qE "^[^#]*\b$HOST_NAME\b" /etc/hosts 2>/dev/null; }

cmd_start() {
  start_server || return $?
  open_browser
}

start_server() {
  if healthy; then say "Brody is already running at $URL"; return 0; fi
  if [ -n "$(listener_pid)" ]; then fail "port $PORT is in use by another program (pid $(listener_pid)). Stop it or set PORT=<other port>."; fi
  command -v node >/dev/null || fail "Node.js is not installed (version 24 or newer is required)."

  if [ ! -d node_modules ]; then say "Installing dependencies (first run)…"; npm install --no-audit --no-fund || fail "npm install failed"; fi
  if needs_build; then say "Building Brody…"; npm run build >"$LOG_FILE" 2>&1 || { tail -20 "$LOG_FILE" >&2; fail "build failed (full log: $LOG_FILE)"; }; fi

  say "Starting Brody…"
  PORT="$PORT" nohup npm start >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 60); do
    healthy && break
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null || { tail -15 "$LOG_FILE" >&2; fail "Brody stopped during startup (see $LOG_FILE)"; }
    sleep 0.5
  done
  healthy || fail "Brody did not become ready in 30 seconds (see $LOG_FILE)"

  say "Brody is running: $URL"
  name_resolves || say "Note: '$HOST_NAME' does not resolve yet. Run once:  echo \"127.0.0.1 $HOST_NAME\" | sudo tee -a /etc/hosts"
}

cmd_stop() {
  local pid; pid="$(listener_pid)"
  if [ -z "$pid" ]; then say "Brody is not running."; rm -f "$PID_FILE"; return 0; fi
  # Stop the whole process group of the server, then make sure the port is free.
  kill "$pid" 2>/dev/null
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null
  for _ in $(seq 1 20); do [ -z "$(listener_pid)" ] && break; sleep 0.25; done
  [ -n "$(listener_pid)" ] && kill -9 "$(listener_pid)" 2>/dev/null
  rm -f "$PID_FILE"
  say "Brody stopped."
}

cmd_status() {
  if healthy; then say "Brody is running: $URL (pid $(listener_pid))"; else say "Brody is not running."; return 1; fi
}

for arg in "$@"; do [ "$arg" = "--no-open" ] && BRODY_OPEN=0; done

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) tail -n "${2:-50}" -f "$LOG_FILE" ;;
  open) BRODY_OPEN=1; cmd_start ;;
  -h|--help|help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "unknown command '$1'. Use: start | stop | restart | status | logs | open  (add --no-open to start/restart to skip the browser)" ;;
esac
