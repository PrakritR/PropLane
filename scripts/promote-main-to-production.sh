#!/usr/bin/env bash
# Retired: production no longer promotes from main.
# Keep this file so old muscle memory fails closed instead of skipping QA.
set -euo pipefail

echo "error: production promotes from staging, not main." >&2
echo "QA must sign off on staging before a live ship." >&2
echo >&2
echo "  npm run ship:staging      # fast-forward main → staging" >&2
echo "  # dedicated QA tests the staging deploy" >&2
echo "  npm run ship:production   # fast-forward staging → production" >&2
echo >&2
echo "See AGENTS.md § Branching & deployment and docs/agents/deployment-workflow.md." >&2
exit 1
