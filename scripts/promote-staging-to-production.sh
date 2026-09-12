#!/usr/bin/env bash
# Fast-forward production to staging and push (Vercel live + iOS TestFlight).
# A narrowly-scoped, dated Akhil authorization can select main with --skip-staging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

POLICY_PATH="docs/agents/temporary-direct-production-policy.json"
DIRECT_SOURCE="origin/main"
DIRECT_TARGET="origin/production"
DIRECT_EXPIRY="2026-09-15T04:00:00Z"

usage() {
  echo "usage: $0 [--skip-staging]" >&2
  exit 1
}

validate_direct_policy() {
  # The policy has an immutable scope and end date in this script, so editing
  # the data file cannot extend or broaden the temporary exception.
  node - "$POLICY_PATH" "$DIRECT_SOURCE" "$DIRECT_TARGET" "$DIRECT_EXPIRY" <<'NODE'
const fs = require("node:fs");
const [policyPath, source, target, expiry] = process.argv.slice(2);
const expected = {
  version: 1,
  kind: "temporary-direct-production-release",
  authorizedDeveloper: "Akhil",
  source,
  target,
  expiresAt: expiry,
};

let policy;
try {
  policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
} catch (error) {
  console.error(`error: direct-production policy is missing or malformed: ${policyPath} (${error instanceof Error ? error.message : "unknown error"})`);
  process.exit(1);
}

if (!policy || typeof policy !== "object" || Array.isArray(policy)
  || Object.keys(policy).length !== Object.keys(expected).length
  || Object.entries(expected).some(([key, value]) => policy[key] !== value)) {
  console.error("error: direct-production policy is malformed or outside the authorized scope");
  process.exit(1);
}

const expiryMs = Date.parse(expiry);
if (!Number.isFinite(expiryMs) || Date.now() >= expiryMs) {
  console.error("error: direct-production authorization has expired");
  process.exit(1);
}
NODE
}

source_branch="staging"
source_ref="origin/staging"
direct_release=false

case "$#" in
  0) ;;
  1)
    if [ "$1" != "--skip-staging" ]; then
      usage
    fi

    validate_direct_policy
    source_branch="main"
    source_ref="$DIRECT_SOURCE"
    direct_release=true
    ;;
  *) usage ;;
esac

git fetch origin "$source_branch" production

if ! git rev-parse "$source_ref" >/dev/null 2>&1; then
  echo "error: $source_ref is missing" >&2
  exit 1
fi

if ! git merge-base --is-ancestor origin/production "$source_ref" 2>/dev/null; then
  echo "error: origin/production is not an ancestor of $source_ref — resolve before ff-only promote" >&2
  exit 1
fi

if [ "$(git rev-parse "$source_ref")" = "$(git rev-parse origin/production 2>/dev/null || echo '')" ]; then
  echo "production already matches $source_ref ($(git rev-parse --short "$source_ref"))"
  exit 0
fi

npm run ship:preflight

# Preflight may take long enough to cross the fixed expiry. Recheck immediately
# before changing branches or pushing production.
if [ "$direct_release" = true ]; then
  validate_direct_policy
fi

git checkout production
git merge --ff-only "$source_ref"
git push origin production
git checkout -

echo "promoted $source_ref → production; watch Vercel Production + iOS TestFlight workflows"
