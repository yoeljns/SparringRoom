#!/usr/bin/env bash
# Local Postgres 16 harness for developing and testing the Supabase migrations
# without a Supabase project. Usage: scripts/dev-db.sh up|reset|test|psql|stop
# Set DATABASE_URL to use an existing server (CI) instead of the local cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA_DIR="${PGDATA_DIR:-/var/lib/dayson-pg}"
PGPORT_LOCAL="${PGPORT_LOCAL:-54329}"
DB="${DB_NAME:-dayson}"
LOCAL_ADMIN="postgresql://postgres@127.0.0.1:${PGPORT_LOCAL}/postgres"
ADMIN_URL="${ADMIN_DATABASE_URL:-$LOCAL_ADMIN}"
URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:${PGPORT_LOCAL}/${DB}}"

as_pg() { if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

up() {
  [ -n "${DATABASE_URL:-}" ] && return 0
  if [ ! -d "$PGDATA_DIR/base" ]; then
    mkdir -p "$PGDATA_DIR"; [ "$(id -u)" = "0" ] && chown postgres:postgres "$PGDATA_DIR"
    as_pg "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! "$PGBIN/pg_isready" -q -h 127.0.0.1 -p "$PGPORT_LOCAL"; then
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PGPORT_LOCAL -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off" -l "$PGDATA_DIR/log.txt" -w start >/dev/null
  fi
}

reset() {
  up
  if [ -z "${DATABASE_URL:-}" ]; then
    psql -Xq "$ADMIN_URL" -c "drop database if exists ${DB} with (force)" -c "create database ${DB}"
  fi
  psql -Xq -v ON_ERROR_STOP=1 "$URL" -f "$ROOT/supabase/tests/shim/supabase_shim.sql"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    psql -Xq -v ON_ERROR_STOP=1 "$URL" -f "$f" >/dev/null || { echo "FAILED: $f"; exit 1; }
  done
  if [ "${SEED:-1}" = "1" ] && [ -f "$ROOT/supabase/seed.sql" ]; then
    psql -Xq -v ON_ERROR_STOP=1 "$URL" -f "$ROOT/supabase/seed.sql" >/dev/null
  fi
  echo "database ready: $URL"
}

run_tests() {
  reset
  psql -Xq "$URL" -c "create extension if not exists pgtap" >/dev/null
  local fail=0
  for f in "$ROOT"/supabase/tests/*.sql; do
    out="$(psql -Xqt -v ON_ERROR_STOP=1 "$URL" -f "$f" 2>&1)" || { echo "$out"; echo "ERROR in $f"; fail=1; continue; }
    okc="$(grep -c '^ *ok ' <<<"$out" || true)"
    if grep -qE '^ *not ok|Looks like|ERROR' <<<"$out"; then
      echo "$out" | grep -E '^ *not ok|^ *#|Looks like|ERROR' ; echo "FAIL $(basename "$f")"; fail=1
    else
      echo "PASS $(basename "$f") ($okc assertions)"
    fi
  done
  if [ -x "$ROOT/supabase/tests/concurrency/run.sh" ]; then
    DATABASE_URL="$URL" "$ROOT/supabase/tests/concurrency/run.sh" || fail=1
  fi
  return $fail
}

case "${1:-}" in
  up) up; echo "postgres up on port $PGPORT_LOCAL" ;;
  reset) reset ;;
  test) run_tests ;;
  psql) up; shift; psql -X "$URL" "$@" ;;
  stop) as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -m fast stop ;;
  *) echo "usage: $0 up|reset|test|psql|stop"; exit 2 ;;
esac
