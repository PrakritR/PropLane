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

find_worktree_for_branch() {
  local branch="$1"
  git worktree list --porcelain | awk -v target="refs/heads/${branch}" '
    /^worktree / { wt = substr($0, 10) }
    /^branch / {
      if ($2 == target) { print wt; exit }
    }
  '
}

MAIN_WT="$(find_worktree_for_branch main || true)"
MAIN_TMP=""
cleanup_main_worktree() {
  if [ -n "$MAIN_TMP" ] && [ -d "$MAIN_TMP" ]; then
    git worktree remove -f "$MAIN_TMP" 2>/dev/null || true
  fi
}
trap cleanup_main_worktree EXIT

if [ -z "$MAIN_WT" ]; then
  MAIN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/proplane-integrate-main.XXXXXX")"
  git worktree add -f "$MAIN_TMP" origin/main -B main
  MAIN_WT="$MAIN_TMP"
fi

run_main() {
  git -C "$MAIN_WT" "$@"
}

run_main fetch origin "$SOURCE" main

run_main checkout main
run_main reset --hard origin/main

if run_main merge-base --is-ancestor "origin/$SOURCE" HEAD; then
  echo "main already contains origin/$SOURCE ($(git rev-parse --short "origin/$SOURCE"))"
else
  if run_main merge-base --is-ancestor HEAD "origin/$SOURCE"; then
    echo "fast-forwarding main to origin/$SOURCE"
    run_main merge --ff-only "origin/$SOURCE"
  else
    echo "merging origin/$SOURCE into main (diverged histories)"
    run_main merge --no-edit "origin/$SOURCE" \
      -m "integrate($SOURCE): merge into main"
  fi
  run_main push origin main
  echo "pushed origin/main at $(run_main rev-parse --short HEAD)"
fi

bash "$MAIN_WT/scripts/promote-main-to-staging.sh"

git fetch origin main staging
echo "integrate: ok — main and staging at $(git rev-parse --short origin/main)"
