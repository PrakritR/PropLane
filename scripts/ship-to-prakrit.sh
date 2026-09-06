#!/usr/bin/env bash
# Promote a sandbox keeper branch into prakrit with security review + no-mistakes.
#
# Captain / firstmate only — agents land on their keeper branch and run
# npm run sandbox:open before handoff. This script reads .proplane-review-path
# from the agent worktree when --path is omitted.
#
# Usage:
#   npm run ship:to-prakrit -- --source cursor-1
#   npm run ship:to-prakrit -- --source cursor-1 --path /portal/tasks
#   npm run ship:to-prakrit -- --source cursor-1 --validate-only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FM_BIN="${FM_BIN:-$HOME/firstmate/bin}"
PROMOTE="$FM_BIN/fm-proplane-promote-to-prakrit.sh"

if [ ! -x "$PROMOTE" ]; then
  echo "ship:to-prakrit: missing $PROMOTE" >&2
  echo "  Install firstmate bin or set FM_BIN to the directory containing fm-proplane-promote-to-prakrit.sh" >&2
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
      echo "usage: npm run ship:to-prakrit -- --source <cursor-1|cursor-2|…> [--path </route>] [--validate-only] [--no-browser]"
      exit 0
      ;;
    *)
      EXTRA+=("$1")
      shift
      ;;
  esac
done

if [ -z "$SOURCE" ]; then
  echo "error: --source <agent-branch> is required (e.g. cursor-1)" >&2
  exit 2
fi

exec "$PROMOTE" "$SOURCE" "${EXTRA[@]}"
