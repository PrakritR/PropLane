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

echo "ship:to-prakrit: use /promote prakrit — this wrapper only runs the prepare step for '$SOURCE'" >&2
echo "  (checkout $SOURCE first: this wrapper does not switch branches for you)" >&2

exec "$PROMOTE" prakrit --prepare "${EXTRA[@]}"
