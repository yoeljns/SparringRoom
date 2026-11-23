#!/usr/bin/env bash
# LOCAL ONLY: reset+seed the dayson_web database, add dev users, start the dev API on :54321.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export DB_NAME="${DB_NAME:-dayson_web}"
if [ "${RESET:-1}" = "1" ]; then
  bash "$ROOT/scripts/dev-db.sh" reset
  psql -Xq -v ON_ERROR_STOP=1 "postgresql://postgres@127.0.0.1:${PGPORT_LOCAL:-54329}/${DB_NAME}" -f "$ROOT/supabase/tests/shim/dev_users.sql"
fi
cd "$ROOT/scripts/dev-api" && [ -d node_modules ] || npm install --silent
DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT_LOCAL:-54329}/${DB_NAME}" exec node server.mjs
