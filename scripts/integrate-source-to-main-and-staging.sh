#!/usr/bin/env bash
# Merge a source branch into main, push, then fast-forward staging to main.
#
# Ladder step: agent / integration branch → main → staging (QA preview).
# Production is a separate promote: npm run ship:production
#
# Usage:
#   bash scripts/integrate-source-to-main-and-staging.sh
#   bash scripts/integrate-source-to-main-and-staging.sh --source cursor-1
#   npm run ship:integrate -- --source prakrit
#
# Refuses when main cannot absorb the source (merge conflict). Never force-pushes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE="${SOURCE:-prakrit}"

usage() {
  echo "usage: integrate-source-to-main-and-staging.sh [--source <branch>]" >&2
  echo "  default source: prakrit (override with --source or SOURCE= env)" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      [ $# -ge 2 ] || {
        echo "error: --source requires a branch name" >&2
        exit 2
      }
      SOURCE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$SOURCE" ]; then
  echo "error: source branch is required" >&2
  exit 2
fi

echo "== integrate $SOURCE → main → staging =="

git fetch origin "$SOURCE" main staging

if ! git rev-parse "origin/$SOURCE" >/dev/null 2>&1; then
  echo "error: origin/$SOURCE does not exist" >&2
  exit 1
fi

if ! git rev-parse origin/main >/dev/null 2>&1; then
  echo "error: origin/main is missing" >&2
  exit 1
fi

git checkout main
git reset --hard origin/main

if git merge-base --is-ancestor "origin/$SOURCE" HEAD; then
  echo "main already contains origin/$SOURCE ($(git rev-parse --short "origin/$SOURCE"))"
else
  if git merge-base --is-ancestor HEAD "origin/$SOURCE"; then
    echo "fast-forwarding main to origin/$SOURCE"
    git merge --ff-only "origin/$SOURCE"
  else
    echo "merging origin/$SOURCE into main (diverged histories)"
    git merge --no-edit "origin/$SOURCE" \
      -m "integrate($SOURCE): merge into main"
  fi
  git push origin main
  echo "pushed origin/main at $(git rev-parse --short HEAD)"
fi

bash "$ROOT/scripts/promote-main-to-staging.sh"

echo "integrate: ok — main and staging aligned ($(git rev-parse --short origin/main))"
