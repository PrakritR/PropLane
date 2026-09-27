#!/usr/bin/env bash
# Fast-forward production to staging and push (Vercel live + iOS TestFlight).
# An Akhil-scoped standing authorization can select main with --skip-staging.
# Deleting the policy file (or changing its scope) revokes it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

POLICY_PATH="docs/agents/temporary-direct-production-policy.json"
DIRECT_SOURCE="origin/main"
DIRECT_TARGET="origin/production"

usage() {
  echo "usage: $0 [--skip-staging]" >&2
  exit 1
}

validate_direct_policy() {
  # The policy's scope is fixed in this script, so editing the data file can
  # revoke the exception (delete it) but never broaden it.
  node - "$POLICY_PATH" "$DIRECT_SOURCE" "$DIRECT_TARGET" <<'NODE'
const fs = require("node:fs");
const [policyPath, source, target] = process.argv.slice(2);
const expected = {
  version: 2,
  kind: "direct-production-release",
  authorizedDeveloper: "Akhil",
  source,
  target,
  // Standing (no end date) since 2026-09-26 at Akhil's request.
  expiresAt: null,
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

# Recheck immediately before changing branches or pushing production, so a
# revocation during preflight still stops the push.
if [ "$direct_release" = true ]; then
  validate_direct_policy
fi

git checkout production
git merge --ff-only "$source_ref"
git push origin production
git checkout -

echo "promoted $source_ref → production; watch Vercel Production + iOS TestFlight workflows"
