#!/usr/bin/env bash
# Local experiment branch for PropPlane agent sandboxes (never pushed to origin by default).
#
# Usage:
#   scripts/proplane-test-branch.sh start calendar-revamp    # test/cursor-2-calendar-revamp
#   scripts/proplane-test-branch.sh finish                   # merge into keeper, delete test branch
#   scripts/proplane-test-branch.sh abort                    # discard test branch
#   scripts/proplane-test-branch.sh status
#
# Keeper branch is read from the current worktree (cursor-2, cursor-1, etc.).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

KEEPER="$(git branch --show-current)"
TEST_BRANCH_FILE="$REPO_ROOT/.git/proplane-test-branch-name"

usage() {
  echo "usage: proplane-test-branch.sh {start <slug>|finish|abort|status}"
  exit 1
}

[[ $# -ge 1 ]] || usage
CMD=$1
shift || true

case "$CMD" in
  start)
    SLUG=${1:?slug required, e.g. calendar-revamp}
    if [[ -f "$TEST_BRANCH_FILE" ]]; then
      echo "error: test branch already active: $(cat "$TEST_BRANCH_FILE")" >&2
      echo "run: scripts/proplane-test-branch.sh finish|abort" >&2
      exit 1
    fi
    TEST="test/${KEEPER}-${SLUG}"
    git checkout -b "$TEST"
    echo "$TEST" > "$TEST_BRANCH_FILE"
    echo "test branch: $TEST (from $KEEPER)"
    echo "When done: scripts/proplane-test-branch.sh finish"
    ;;
  finish)
    TEST=$(cat "$TEST_BRANCH_FILE" 2>/dev/null || true)
    [[ -n "$TEST" ]] || { echo "no active test branch"; exit 1; }
    git checkout "$KEEPER"
    git merge --no-ff "$TEST" -m "merge($TEST): experiment into $KEEPER"
    git branch -d "$TEST"
    rm -f "$TEST_BRANCH_FILE"
    echo "merged $TEST → $KEEPER"
    ;;
  abort)
    TEST=$(cat "$TEST_BRANCH_FILE" 2>/dev/null || true)
    [[ -n "$TEST" ]] || { echo "no active test branch"; exit 1; }
    git checkout "$KEEPER"
    git branch -D "$TEST"
    rm -f "$TEST_BRANCH_FILE"
    echo "aborted $TEST"
    ;;
  status)
    if [[ -f "$TEST_BRANCH_FILE" ]]; then
      echo "active: $(cat "$TEST_BRANCH_FILE")"
      git status -sb
    else
      echo "no test branch (on $KEEPER)"
    fi
    ;;
  *)
    usage
    ;;
esac
