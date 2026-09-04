#!/usr/bin/env bash
# Preflight before promoting main → production (production is the live branch).
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

if [[ -f "vercel.json" ]] && grep -q '"main": true' vercel.json && grep -q '"production": true' vercel.json && grep -q '"\*\*": false' vercel.json; then
  pass "vercel.json enables main (preview) and production (live) only"
else
  bad "vercel.json must set git.deploymentEnabled main=true, production=true, and **=false"
fi

if [[ -f "scripts/vercel-should-build.sh" ]] && grep -q 'production' scripts/vercel-should-build.sh && grep -q 'main' scripts/vercel-should-build.sh; then
  pass "vercel-should-build.sh allows main and production"
else
  bad "scripts/vercel-should-build.sh must allow main and production refs"
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

echo
echo "Required before promote (see docs/ship-gate.md):"
echo "  [ ] security-review + bugbot on branch changes"
echo "  [ ] cache/rendering/perf pass for UI/route changes"
echo "  [ ] full feature walkthrough + edge cases (not /demo alone)"
echo "  [ ] unit/integration tests green"
echo "  [ ] ff-only merge main → production + git push origin production"
echo "  [ ] after push: Vercel production + GitHub Action 'iOS TestFlight' green"
echo "  [ ] ASC secrets ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 configured in GitHub"
echo

if [[ "$fail" -gt 0 ]]; then
  echo "Result: FAIL ($fail failed, $warn warnings, $ok ok)"
  exit 1
fi
echo "Result: PASS ($ok ok, $warn warnings)"
exit 0
