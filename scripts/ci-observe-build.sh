#!/usr/bin/env bash
# CI-only resource evidence. No command arguments or environment values are logged.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo 'CI build observer requires GitHub Actions.' >&2
  exit 2
fi
ci_resource_sampler() {
  set +e
  ci_sampler_sleep_pid=''
  trap 'if [ -n "$ci_sampler_sleep_pid" ]; then kill "$ci_sampler_sleep_pid" 2>/dev/null; wait "$ci_sampler_sleep_pid" 2>/dev/null; fi; exit 0' TERM INT
  while true; do
    date -u '+CI resource sample %Y-%m-%dT%H:%M:%SZ'
    free -m 2>/dev/null
    # `comm` is the process name, not argv or environment. sed reads the full pipe.
    ps -eo pid,ppid,rss,comm --sort=-rss 2>/dev/null | sed -n '1,12p'
    for ci_metric in memory.current memory.max memory.events; do
      if [ -r "/sys/fs/cgroup/$ci_metric" ]; then
        echo "CI cgroup $ci_metric"
        cat "/sys/fs/cgroup/$ci_metric"
      fi
    done
    sleep 15 & ci_sampler_sleep_pid=$!
    wait "$ci_sampler_sleep_pid"
    ci_sampler_sleep_pid=''
  done
}
ci_resource_sampler &
ci_resource_sampler_pid=$!
echo "CI resource sampler pid $ci_resource_sampler_pid"
ci_observer_cleanup() {
  ci_observer_build_status=$?
  trap - EXIT INT TERM
  kill "$ci_resource_sampler_pid" 2>/dev/null || true
  wait "$ci_resource_sampler_pid" 2>/dev/null || true
  exit "$ci_observer_build_status"
}
trap ci_observer_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
npm run build
