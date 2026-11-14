#!/usr/bin/env bash
# Runs the built image against a real PostgreSQL in an isolated Compose project:
# migrations, API and worker-once smoke checks, the API's access log, the API
# and worker connected as the non-superuser runtime role, liveness that
# survives a database outage, the fail-fast worker's restart and recovery, and
# data kept in the volume.
# Build the image first (`docker build -t node-effect-template:local .`).
set -euo pipefail
cd "$(dirname "$0")/.."

export APP_IMAGE=${APP_IMAGE:-node-effect-template:local}
export POSTGRES_DB=smoke_test POSTGRES_USER=smoke_test POSTGRES_PASSWORD=smoke_test
export APP_DATABASE_USER=smoke_test_app APP_DATABASE_PASSWORD=smoke_test_app
# The worker logs each successful pass at Debug, which wait_for_worker_pass reads.
export API_PORT=0 COMPOSE_PROFILES='' WORKER_POLL_INTERVAL_MS=500 LOG_LEVEL=Debug
project="node-effect-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
compose=(docker compose --env-file .env.example -f docker-compose.yml --profile app -p "$project")

cleanup() {
  status=$?
  if [[ "$status" != 0 ]]; then
    "${compose[@]}" logs --no-color
  fi
  "${compose[@]}" down --volumes --remove-orphans
  exit "$status"
}
trap cleanup EXIT

wait_for_worker_restart() {
  for _ in {1..30}; do
    if test "$(docker inspect --format '{{.RestartCount}}' "$worker_id")" -gt 0; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for the worker to restart" >&2
  return 1
}

# Waits for the worker to log a successful pass after a Docker timestamp. A
# running container alone proves nothing: a crash-looping worker is briefly
# running before each failure.
wait_for_worker_pass() {
  # Docker's restart delay doubles while the worker keeps failing.
  for _ in {1..120}; do
    logs=$("${compose[@]}" logs --no-color --since "$1" worker)
    if [[ $logs == *"Worker user sample loaded"* ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for a successful worker pass" >&2
  return 1
}

# Waits for an API log line that contains both strings. Docker collects a
# container's output asynchronously, so a line can arrive after the response.
wait_for_api_log() {
  for _ in {1..10}; do
    if "${compose[@]}" logs --no-color api | grep -F "$1" | grep -F "$2" > /dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for the API to log $1 with $2" >&2
  return 1
}

# The daemon's clock, which also stamps the container logs.
docker_time() {
  docker info --format '{{.SystemTime}}'
}

psql_query() {
  "${compose[@]}" exec -T postgresql psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --tuples-only \
    --no-align \
    --command "$1"
}

started=$(docker_time)
"${compose[@]}" up -d --no-build --wait --wait-timeout 120
address=$("${compose[@]}" port api 8000)
curl --fail --silent --show-error "http://$address/health/live"
curl --fail --silent --show-error "http://$address/health/ready"
"${compose[@]}" exec -T api node scripts/smoke-api.ts

# The access log has a line per request, with the trace id and Cloudflare's ray
# id but not the query string, and none for the passing health probes above,
# smoke-api.ts's and the Compose healthcheck's. Effect's own HTTP logger, if it
# came back, would log those probes under http.url and a 404's query string in
# its cause.
curl --fail --silent --show-error --output /dev/null \
  --header 'cf-ray: smoke-ray-0000-SMK' "http://$address/users?limit=1&smoke=QUERY_SENTINEL"
status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  "http://$address/nope?smoke=QUERY_SENTINEL")
test "$status" = 404
wait_for_api_log '"cfRay":"smoke-ray-0000-SMK"' '"traceId":'
wait_for_api_log '"path":"/nope"' '"status":404'
if "${compose[@]}" logs --no-color api |
  grep -E -e QUERY_SENTINEL -e '"(path|http\.url)":"/health' -e '"http\.status"' > /dev/null; then
  echo "The access log has a query string, a passing health probe or Effect's own logger" >&2
  exit 1
fi
"${compose[@]}" run --rm --no-deps worker-once
"${compose[@]}" run --rm --no-deps migrate

# Before the outage the worker has completed a pass and never restarted, so the
# restart below is the outage's doing.
worker_id=$("${compose[@]}" ps -q worker)
wait_for_worker_pass "$started"
test "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$worker_id")" = "running 0"

# The API and the worker, at least two containers with pooled connections
# still open, are connected as the runtime role, which is no superuser and
# belongs to no other role whose privileges it would inherit.
application_sessions="from pg_stat_activity join pg_roles on rolname = usename
  where application_name = 'node-effect-template'"
roles=$(psql_query "select string_agg(distinct usename || ' ' || rolsuper, ',') $application_sessions")
test "$roles" = "$APP_DATABASE_USER false"
test "$(psql_query "select count(distinct client_addr) $application_sessions")" -ge 2
test "$(psql_query "select count(*) from pg_auth_members
  where member = '$APP_DATABASE_USER'::regrole")" -eq 0

# Database loss affects readiness, not the API process liveness probe. The
# worker fails fast and relies on its restart policy.
"${compose[@]}" stop postgresql
curl --fail --silent --show-error "http://$address/health/live"
status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://$address/health/ready")
test "$status" = 503
wait_for_api_log '"path":"/health/ready","status":503' '"level":"ERROR"'
wait_for_worker_restart

# Also prove that a newly started API can serve liveness without PostgreSQL.
"${compose[@]}" up -d --no-build --no-deps --force-recreate --wait --wait-timeout 90 api
address=$("${compose[@]}" port api 8000)
curl --fail --silent --show-error "http://$address/health/live"

# Restore the database and verify that its named volume kept the data and the
# migration history, and that the restarted worker completes a pass again.
restored=$(docker_time)
"${compose[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 90 postgresql
"${compose[@]}" up -d --no-build --no-deps --force-recreate --wait --wait-timeout 90 api
address=$("${compose[@]}" port api 8000)
curl --fail --silent --show-error "http://$address/health/ready"
curl --fail --silent --show-error "http://$address/users" | grep -F 'ada@example.com' > /dev/null
migration_count=$(psql_query 'select count(*) from drizzle.__drizzle_migrations')
test "$migration_count" -gt 0
wait_for_worker_pass "$restored"
echo "Docker smoke checks passed, including the runtime role, independent liveness, persistent data, and worker modes"
