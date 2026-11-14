# shellcheck shell=bash
# Reports how a job ended to a dead man's switch: a GET of the URL when it
# succeeds, and a POST to <URL>/fail when it fails, with the last lines it wrote
# to standard error as the body. Healthchecks.io and Better Stack both read a
# check's URL and its /fail suffix this way. Cronitor and Uptime Kuma take the
# outcome as a query parameter instead, so /fail would land in the query string
# and could read as success: a URL with a query string is refused.
#
# The switch also alerts when no ping arrives in time, which covers a job that
# never ran and a host that is down. Reporting never changes the job's exit
# status, and gives up after about a minute.
#
#   source bin/heartbeat.sh
#   heartbeat_init "${HEARTBEAT_URL:-}"   # first; an empty URL reports nothing
#
# A script that defines `cleanup` has it run on every exit, before the report.

# Healthchecks.io keeps the first 100 kB of a ping's body. The last lines say
# why a job failed; the journal has the rest.
heartbeat_body_lines=20
heartbeat_body_bytes=10000

heartbeat_init() {
  heartbeat_url=${1%/}
  if [[ $heartbeat_url == *'?'* ]]; then
    echo "Not reporting to the dead man's switch: /fail cannot follow a URL with a query string" >&2
    heartbeat_url=
  fi

  # Standard error also goes to a file, which the failure report quotes. When
  # systemd stops the service, SIGTERM reaches every process in it; tee ignores
  # it, so the last lines still arrive.
  heartbeat_errors=$(mktemp)
  exec {heartbeat_stderr}>&2
  exec 2> >(
    trap '' TERM
    exec tee -a "$heartbeat_errors" >&"$heartbeat_stderr"
  )
  heartbeat_tee=$!

  trap heartbeat_exit EXIT
  # systemd sends SIGTERM when it stops the service or the run passes
  # TimeoutStartSec. Without a trap, bash would die without running EXIT.
  trap 'echo "Stopped by SIGTERM: systemctl stop, or the run passed TimeoutStartSec" >&2; exit 143' TERM
  trap 'echo "Interrupted" >&2; exit 130' INT
}

heartbeat_exit() {
  local status=$?
  # The report runs to the end, whatever fails in it and whatever signal comes.
  set +e
  trap '' TERM INT

  if declare -F cleanup > /dev/null && ! cleanup && ((status == 0)); then
    status=1
  fi

  exec 2>&"$heartbeat_stderr"
  wait "$heartbeat_tee"

  if [[ -n $heartbeat_url ]]; then
    local curl=(curl -fsS -m 10 --retry 3 --retry-all-errors --retry-max-time 60 -o /dev/null)
    if ((status == 0)); then
      "${curl[@]}" "$heartbeat_url"
    else
      # Compose quotes the value of a line of .env it cannot parse, which can be
      # a password; the journal keeps the whole line.
      tail -n "$heartbeat_body_lines" "$heartbeat_errors" |
        sed -E 's/(\.env: line [0-9]+:).*/\1 [redacted]/' |
        tail -c "$heartbeat_body_bytes" |
        "${curl[@]}" --data-binary @- "$heartbeat_url/fail"
    fi || echo "Could not report to the dead man's switch" >&2
  fi

  rm -f "$heartbeat_errors"
  exit "$status"
}
