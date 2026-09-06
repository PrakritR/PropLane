#!/usr/bin/env bash
# Preflight before promoting staging → production (production is the live branch).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok=0
warn=0
fail=0

pass() { echo "OK   $*"; ok=$((ok + 1)); }
note() { echo "WARN $*"; warn=$((warn + 1)); }
bad()  { echo "FAIL $*"; fail=$((fail + 1)); }

echo "== PropLane ship preflight =="

WF=".github/workflows/ios-testflight.yml"
if [[ -f "$WF" ]]; then
  if grep -Eq 'branches:[[:space:]]*\[[^]]*\bproduction\b|^[[:space:]]*-[[:space:]]*production[[:space:]]*$' "$WF" && grep -q "fastlane beta" "$WF"; then
    pass "iOS TestFlight workflow triggers on production and runs fastlane beta"
  else
    bad "iOS TestFlight workflow must trigger on production and run fastlane beta"
  fi
else
  bad "missing $WF — pushes to production will not upload to TestFlight"
fi

if [[ -f "scripts/verify-cap-prod-config.sh" ]]; then
  pass "Capacitor Release prod-URL guard present"
else
  note "missing scripts/verify-cap-prod-config.sh"
fi

if [[ -f "docs/ship-gate.md" ]]; then
  pass "docs/ship-gate.md checklist present"
else
  note "missing docs/ship-gate.md"
fi

if node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

try {
  const enabled = JSON.parse(readFileSync('vercel.json', 'utf8')).git?.deploymentEnabled;
  const valid = enabled && typeof enabled === 'object' && !Array.isArray(enabled)
    && enabled.main === false && enabled['**'] === false
    && enabled.staging === true && enabled.production === true
    && Object.entries(enabled).every(([branch, value]) =>
      value === (branch === 'staging' || branch === 'production'));
  process.exit(valid ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
then
  pass "vercel.json enables staging and production only; main uses localhost"
else
  bad "vercel.json must enable only staging and production, with main=false and **=false"
fi

if [[ -f "scripts/vercel-should-build.sh" ]]; then
  for ref in main staging production feat/preflight unknown; do
    expected=0
    if [[ "$ref" = staging || "$ref" = production ]]; then expected=1; fi
    actual=0
    VERCEL_GIT_COMMIT_REF="$ref" bash scripts/vercel-should-build.sh || actual=$?
    if [[ "$actual" -eq "$expected" ]]; then
      pass "Vercel build gate: $ref exits $expected"
    else
      bad "Vercel build gate: $ref exits $actual, expected $expected"
    fi
  done
else
  bad "missing scripts/vercel-should-build.sh"
fi

if git ls-remote --exit-code origin refs/heads/staging >/dev/null 2>&1; then
  pass "origin/staging branch exists"
else
  bad "missing origin/staging — run npm run ship:staging before promoting live"
fi

if git ls-remote --exit-code origin refs/heads/production >/dev/null 2>&1; then
  pass "origin/production branch exists"
else
  bad "missing origin/production — create it before promoting live"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "INFO current branch: $BRANCH"

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  note "working tree is dirty — commit or stash before promote"
else
  pass "working tree clean"
fi

# PRP-114: a critical variable that is EMPTY in Vercel Production reads as
# present in the dashboard, so a whole feature ships dark and fails closed in
# silence. This names the feature that would go dark, not the variable.
if [[ -f "scripts/check-production-env.mjs" ]]; then
  echo
  echo "-- production env --"
  echo "INFO checking THIS shell's env; run against production with:"
  echo "     vercel env pull .env.production.check --environment=production && \\"
  echo "       node --env-file=.env.production.check scripts/check-production-env.mjs"
  if node scripts/check-production-env.mjs; then
    pass "critical production variables provisioned in this environment"
  else
    note "critical variables empty here — verify against Vercel Production before promoting"
  fi
else
  note "missing scripts/check-production-env.mjs — cannot detect silently-dark features"
fi

# PRP-273: denied agent proposals are the primary eval set — every one is a case where a
# person looked at what the assistant wanted to do and said no. Replaying them against the
# CURRENT prompts and tool schemas catches a change that reintroduces a rejected behaviour.
#
# A WARNING, never a failure. It depends on a live third-party service, and a promote must not
# be blocked because an observability provider is unreachable. The weekly
# `.github/workflows/agent-regression.yml` run is the one that is meant to be watched; this is
# here so a promote gets a fresh answer when the credentials happen to be present.
if [[ -f "scripts/langfuse-run-agent-regression.mjs" ]]; then
  echo
  echo "-- agent regression --"
  if [[ -n "${LANGFUSE_PUBLIC_KEY:-}" && -n "${LANGFUSE_SECRET_KEY:-}" ]]; then
    if npm run --silent langfuse:run-regression -- --run="preflight-$(date +%Y%m%d-%H%M%S)"; then
      pass "denied agent proposals replay clean against current prompts and tools"
    else
      note "agent regression reported a re-proposed denied action — review before promoting"
    fi
  else
    note "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset — agent regression not run"
  fi
else
  note "missing scripts/langfuse-run-agent-regression.mjs"
fi

echo
echo "Required before promote (see docs/ship-gate.md):"
echo "  [ ] security-review + bugbot on branch changes"
echo "  [ ] cache/rendering/perf pass for UI/route changes"
echo "  [ ] full feature walkthrough + edge cases (not /demo alone)"
echo "  [ ] unit/integration tests green"
echo "  [ ] ff-only merge main → staging, QA sign-off, then staging → production"
echo "  [ ] after push: Vercel production + GitHub Action 'iOS TestFlight' green"
echo "  [ ] ASC secrets ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 configured in GitHub"
echo

if [[ "$fail" -gt 0 ]]; then
  echo "Result: FAIL ($fail failed, $warn warnings, $ok ok)"
  exit 1
fi
echo "Result: PASS ($ok ok, $warn warnings)"
exit 0
