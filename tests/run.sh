#!/bin/bash
# Owns the throwaway Postgres container's lifecycle, then runs the plain-script
# regression suite (tests/regression.test.mjs) against it.
set -e
CONTAINER=ccc-regression-pg
PG_PORT=55433
APP_PORT=8321

cd "$(dirname "$0")/.."

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=railway -p "$PG_PORT:5432" postgres:16-alpine >/dev/null

echo "waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" psql -U postgres -d railway -c "SELECT 1" >/dev/null 2>&1; then
    echo "postgres ready after ${i}s"
    break
  fi
  sleep 1
done

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

DATABASE_URL="postgresql://postgres:test@localhost:$PG_PORT/railway" PORT="$APP_PORT" node tests/regression.test.mjs
