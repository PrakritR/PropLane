#!/usr/bin/env bash
# Deploy PropLane to Vercel via CLI when Git integration is stale or GitHub
# Actions lacks VERCEL_TOKEN (the workflow then skips the real deploy job).
#
# The live Vercel *project name* is still "axis-2"; domains are prop-lane.space.
# Do not use the auto-created "proplane-cursor-branch-1" sandbox project for prod.
#
# One-time link (from repo root):
#   npx vercel link --project axis-2
#
# Usage:
#   npm run vercel:deploy:staging       # QA preview (staging branch)
#   npm run vercel:deploy:production    # live prop-lane.space (production branch)
#   bash scripts/vercel-deploy-cli.sh production --dry-run
#
# GitHub backup (recommended): add repo secrets VERCEL_TOKEN, VERCEL_ORG_ID,
# VERCEL_PROJECT_ID from .vercel/project.json so .github/workflows/vercel-deploy.yml
# deploys on every push to staging / production. main uses localhost.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-production}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    staging | production | main) TARGET="$arg" ;;
  esac
done

case "$TARGET" in
  production) GIT_BRANCH=production; VERCEL_ENV=production; PROD_FLAG=(--prod) ;;
  staging) GIT_BRANCH=staging; VERCEL_ENV=preview; PROD_FLAG=() ;;
  main)
    echo "error: main uses localhost; promote to staging for a deployed QA preview" >&2
    exit 2
    ;;
  *)
    echo "usage: $0 [production|staging] [--dry-run]" >&2
    exit 2
    ;;
esac

if ! command -v vercel >/dev/null 2>&1; then
  echo "error: vercel CLI not found — run: npm install -g vercel@latest" >&2
  exit 1
fi

if [[ ! -f .vercel/project.json ]]; then
  echo "error: not linked to a Vercel project — run: npx vercel link --project axis-2" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$CURRENT_BRANCH" != "$GIT_BRANCH" ]]; then
  echo "warning: on branch '$CURRENT_BRANCH' but deploying as '$GIT_BRANCH' ref" >&2
fi

SHA="$(git rev-parse --short HEAD)"
echo "== Vercel CLI deploy ($TARGET @ $SHA) =="
echo "project: $(node -e "console.log(JSON.parse(require('fs').readFileSync('.vercel/project.json','utf8')).projectId)")"
echo "environment: $VERCEL_ENV"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN — would run: vercel pull, vercel build ${PROD_FLAG[*]}, vercel deploy --prebuilt ${PROD_FLAG[*]}"
  exit 0
fi

npm run lockfile:verify

if [[ "$VERCEL_ENV" = "production" ]]; then
  vercel pull --yes --environment=production
  vercel build --prod
  vercel deploy --prebuilt --prod
else
  vercel pull --yes --environment=preview --git-branch=staging
  vercel build
  vercel deploy --prebuilt
fi

echo "done — confirm in Vercel → axis-2 → Deployments (Production should match origin/$GIT_BRANCH)"
