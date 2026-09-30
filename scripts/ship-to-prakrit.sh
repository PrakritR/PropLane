#!/usr/bin/env bash
# Thin wrapper around the one /promote implementation (lane-workflow v2).
#
# This used to drive firstmate's fm-proplane-promote-to-prakrit.sh directly.
# That two-step flow (validate on an integrate/* branch, then merge into
# prakrit) is now promote.sh's own prakrit --prepare / --land split, with the
# no-mistakes skill driven interactively in between — see
# ~/.claude/skills/promote/SKILL.md. Prefer /promote prakrit directly; this
# wrapper exists only for the npm run ship:to-prakrit muscle memory.
#
# Usage:
#   npm run ship:to-prakrit -- --source cursor-1
#   npm run ship:to-prakrit -- --source cursor-1 --dry-run
set -euo pipefail

PROMOTE="$HOME/.claude/skills/promote/promote.sh"

if [ ! -x "$PROMOTE" ]; then
  echo "ship:to-prakrit: missing $PROMOTE" >&2
  exit 1
fi

SOURCE=""
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      SOURCE="${2:?--source requires a branch name}"
      shift 2
      ;;
    --help|-h)
      echo "usage: npm run ship:to-prakrit -- --source <lane> [--dry-run]" >&2
      echo "  use /promote prakrit --prepare" >&2
      exit 0
      ;;
    *)
      EXTRA+=("$1")
      shift
      ;;
  esac
done

if [ -z "$SOURCE" ]; then
  echo "error: --source <lane> is required (e.g. claude-1)" >&2
  exit 2
fi

# promote.sh derives the lane from HEAD, not from an argument, so a --source
# that names a different branch would silently prepare (and force-push) the
# checked-out one instead. Fail closed rather than warn.
CURRENT="$(git symbolic-ref --quiet --short HEAD || true)"
if [ -z "$CURRENT" ]; then
  echo "error: HEAD is detached — check out $SOURCE before running this" >&2
  exit 2
fi
if [ "$SOURCE" != "$CURRENT" ]; then
  echo "error: --source '$SOURCE' is not the checked-out branch ('$CURRENT')" >&2
  echo "  /promote prakrit prepares whatever HEAD points at, so this would have prepared '$CURRENT'." >&2
  echo "  check out $SOURCE (or run this from that lane's own worktree) and try again." >&2
  exit 2
fi

echo "ship:to-prakrit: use /promote prakrit — this wrapper only runs the prepare step for '$SOURCE'" >&2

# bash 3.2 (/bin/bash on macOS) treats "${EXTRA[@]}" on an empty array as an
# unbound variable under `set -u`, so guard the expansion.
exec "$PROMOTE" prakrit --prepare ${EXTRA[@]+"${EXTRA[@]}"}
