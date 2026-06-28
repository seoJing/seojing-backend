#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_DIR="${POSTGRES_DATA_DIR:-$ROOT_DIR/.local/postgres-data}"
LOG_FILE="${POSTGRES_LOG_FILE:-$ROOT_DIR/.local/postgres.log}"
PORT="${POSTGRES_PORT:-5432}"
USER_NAME="${POSTGRES_USER:-seojing}"
DB_NAME="${POSTGRES_DB:-seojing_backend}"

# Homebrew PostgreSQL can fail on macOS with `postmaster became multithreaded`
# unless the locale is pinned to a valid value.
export LC_ALL="${LC_ALL:-C}"
export LANG="${LANG:-C}"

usage() {
  echo "Usage: $0 {start|stop|status|reset}"
}

init_cluster() {
  mkdir -p "$(dirname "$DB_DIR")"
  if [ ! -d "$DB_DIR/base" ]; then
    initdb -D "$DB_DIR" --username="$USER_NAME" --auth=trust --no-locale --encoding=UTF8
  fi
}

wait_until_ready() {
  for _ in $(seq 1 30); do
    if pg_isready -h localhost -p "$PORT" -U "$USER_NAME" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  tail -100 "$LOG_FILE" || true
  return 1
}

start() {
  init_cluster
  if pg_ctl -D "$DB_DIR" status >/dev/null 2>&1; then
    echo "Postgres already running at $DB_DIR"
  else
    pg_ctl -D "$DB_DIR" -l "$LOG_FILE" -o "-p $PORT -k /tmp" start
  fi
  wait_until_ready
  createdb -h localhost -p "$PORT" -U "$USER_NAME" "$DB_NAME" 2>/dev/null || true
  echo "Postgres ready: postgresql://$USER_NAME@localhost:$PORT/$DB_NAME"
}

stop() {
  pg_ctl -D "$DB_DIR" stop -m fast || true
}

status() {
  pg_ctl -D "$DB_DIR" status || true
  pg_isready -h localhost -p "$PORT" -U "$USER_NAME" || true
}

reset() {
  stop
  rm -rf "$DB_DIR" "$LOG_FILE"
  start
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  reset) reset ;;
  *) usage; exit 2 ;;
esac
