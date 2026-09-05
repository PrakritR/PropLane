#!/usr/bin/env bash
# Fast-forward production to staging and push (Vercel live + iOS TestFlight).
# Production promotes from staging only — never from main.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git fetch origin staging production

if ! git rev-parse origin/staging >/dev/null 2>&1; then
  echo "error: origin/staging is missing — run npm run ship:staging first" >&2
  exit 1
fi

if ! git merge-base --is-ancestor origin/production origin/staging 2>/dev/null; then
  echo "error: origin/production is not an ancestor of origin/staging — resolve before ff-only promote" >&2
  exit 1
fi

if [ "$(git rev-parse origin/staging)" = "$(git rev-parse origin/production 2>/dev/null || echo '')" ]; then
  echo "production already matches staging ($(git rev-parse --short origin/staging))"
  exit 0
fi

npm run ship:preflight

git checkout production
git merge --ff-only origin/staging
git push origin production
git checkout -

echo "promoted staging → production; watch Vercel Production + iOS TestFlight workflows"
