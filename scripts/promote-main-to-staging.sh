#!/usr/bin/env bash
# Fast-forward staging to main and push (Vercel QA preview).
# Staging is the QA rung: developers have already verified main.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git fetch origin main

if ! git rev-parse origin/main >/dev/null 2>&1; then
  echo "error: origin/main is missing" >&2
  exit 1
fi

if ! git ls-remote --exit-code origin refs/heads/staging >/dev/null 2>&1; then
  echo "origin/staging does not exist yet — creating it from origin/main"
  git push origin "origin/main:refs/heads/staging"
  echo "created staging at $(git rev-parse --short origin/main)"
  exit 0
fi

git fetch origin staging

if ! git merge-base --is-ancestor origin/staging origin/main 2>/dev/null; then
  echo "error: origin/staging is not an ancestor of origin/main — resolve before ff-only promote" >&2
  exit 1
fi

if [ "$(git rev-parse origin/main)" = "$(git rev-parse origin/staging)" ]; then
  echo "staging already matches main ($(git rev-parse --short origin/main))"
  exit 0
fi

git checkout staging
git merge --ff-only origin/main
git push origin staging
git checkout -

echo "promoted main → staging; watch the Vercel Preview for staging and Test on staging"
