#!/usr/bin/env bash
# Overnight manager + resident portal Playwright sweeps.
# Logs to .overnight-portal-bug-hunt/ with timestamps.
#
# Auth budget: dev/test Supabase shares ONE /auth/v1/token rate limit across
# all agents (PRP-364). This script signs in ONCE per cycle via auth.setup,
# then reuses storageState — never signIn() per path or per spec file.
#
# Run from repo root while dev server is on localhost:3010:
#   npm run sandbox:pin -- 3010 && npm run dev -- -p 3010
#   OVERNIGHT_STOP_AT=08:00 ./scripts/overnight-portal-bug-hunt.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${ROOT}/.overnight-portal-bug-hunt"
mkdir -p "$LOG_DIR"

BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:3010}"
export PLAYWRIGHT_SKIP_WEBSERVER=1
export PLAYWRIGHT_BASE_URL="$BASE_URL"
export E2E_TESTS_ENABLED=1

STOP_AT="${OVERNIGHT_STOP_AT:-}"
RATE_LIMIT_BACKOFF_SEC="${OVERNIGHT_RATE_LIMIT_BACKOFF_SEC:-1800}"

stop_epoch() {
  if [[ -z "$STOP_AT" ]]; then
    echo 0
    return
  fi
  local today target now
  today="$(date +%Y-%m-%d)"
  target="$(date -j -f "%Y-%m-%d %H:%M" "${today} ${STOP_AT}" +%s 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [[ "$target" -gt "$now" ]]; then
    echo "$target"
  else
    date -j -v+1d -f "%Y-%m-%d %H:%M" "${today} ${STOP_AT}" +%s 2>/dev/null || echo 0
  fi
}

should_stop() {
  local end
  end="$(stop_epoch)"
  [[ "$end" != "0" && "$(date +%s)" -ge "$end" ]]
}

auth_budget_ok() {
  local check
  check="$(npm run test:accounts:check 2>&1 || true)"
  if echo "$check" | grep -q "Request rate limit reached"; then
    return 1
  fi
  if echo "$check" | grep -q "QA account(s) unusable"; then
    return 1
  fi
  return 0
}

run_cycle() {
  local stamp log
  stamp="$(date +%Y%m%d-%H%M%S)"
  log="${LOG_DIR}/${stamp}-full-cycle.log"
  echo "=== $(date -Iseconds) full-cycle (single auth.setup via playwright project deps) ===" | tee "$log"

  # One playwright invocation → setup project runs once, then all specs reuse storageState.
  if npx playwright test \
    tests/e2e/manager-portal-ui-bug-hunt.spec.ts \
    tests/e2e/resident-portal-ui-bug-hunt.spec.ts \
    tests/e2e/manager-portal.spec.ts \
    tests/e2e/resident-portal.spec.ts \
    tests/e2e/manager-filter-dropdown-walkthrough.spec.ts \
    tests/e2e/mobile-portal-layout.spec.ts \
    tests/e2e/portal-interconnect.spec.ts \
    tests/e2e/ui-consistency.spec.ts \
    --workers=1 2>&1 | tee -a "$log"; then
    echo "PASS full-cycle" | tee -a "$log"
  else
    echo "FAIL full-cycle (see $log)" | tee -a "$log"
  fi
}

echo "Overnight portal bug hunt → $LOG_DIR"
echo "Base URL: $BASE_URL"
echo "Stop at: ${STOP_AT:-never (Ctrl+C to stop)}"
echo "PRP-364: backs off ${RATE_LIMIT_BACKOFF_SEC}s when shared auth budget is exhausted"

while true; do
  if should_stop; then
    echo "Reached stop time $STOP_AT — exiting."
    break
  fi

  if ! auth_budget_ok; then
    echo "=== $(date -Iseconds) Shared Supabase auth budget exhausted (429) — backing off ${RATE_LIMIT_BACKOFF_SEC}s (PRP-364) ==="
    sleep "$RATE_LIMIT_BACKOFF_SEC"
    continue
  fi

  run_cycle

  echo "=== Cycle complete $(date -Iseconds); sleeping 600s ==="
  sleep 600
done
