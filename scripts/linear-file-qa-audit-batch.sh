#!/usr/bin/env bash
# File QA audit tickets from cursor-1 portal sweep (2026-09-04).
# Skips duplicates of PRP-185–196 and PRP-170–179.
# Requires LINEAR_API_KEY in .env.local
#
# Usage:
#   bash scripts/linear-file-qa-audit-batch.sh
#   bash scripts/linear-file-qa-audit-batch.sh --dry-run

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY=()
[[ "${1:-}" == "--dry-run" ]] && DRY=(--dry-run)

run_ticket() {
  if ((${#DRY[@]})); then
    npm run linear:ticket -- --dry-run "$@"
  else
    npm run linear:ticket -- "$@"
  fi
}

echo "=== QA audit tickets (cursor-1, 2026-09-04) ==="

run_ticket \
  --title "[Manager] Applications pending tab shows blank when queue is empty" \
  --project "02 — Manager Portal" \
  --milestone "Applications" \
  --priority 4 \
  --labels "Improvement,portal:manager,area:applications,qa:audit" \
  --body "$(cat <<'EOF'
## User story
When no applications are pending, the manager still sees a clear empty state — not a blank table.

## Found during QA
`scripts/qa-deep-portal-interactions.mjs` on http://localhost:3010 — `/portal/applications/pending` has no rows and no empty-state copy.

## Expected
Properties-style empty state or “No pending applications” message.

## Acceptance
- [ ] Empty pending queue shows intentional empty state
- [ ] Manual check on localhost:3010 as manager@test.proplane.local
EOF
)"

run_ticket \
  --title "[Vendor] Calendar returns 403 on vendor portal" \
  --project "04 — Vendor Portal" \
  --milestone "Calendar" \
  --priority 3 \
  --labels "Bug,portal:vendor,area:calendar,qa:audit" \
  --body "$(cat <<'EOF'
## User story
A signed-in vendor can open Calendar without authorization errors.

## Found during QA
`scripts/qa-full-portal-audit.mjs` — console reports `403 Forbidden` loading resources on `/vendor/calendar`.

## Expected
Calendar grid or empty state loads; no 403 in network tab.

## Acceptance
- [ ] Vendor calendar loads for vendor@test.proplane.local
- [ ] API route authorizes vendor_user_id scope
EOF
)"

run_ticket \
  --title "[Manager] Seeded manager sees zero properties on Listed tab" \
  --project "02 — Manager Portal" \
  --milestone "Properties" \
  --priority 3 \
  --labels "Bug,portal:manager,area:listings,qa:audit" \
  --body "$(cat <<'EOF'
## User story
`manager@test.proplane.local` on dev should show seeded portfolio rows on Properties → Listed.

## Found during QA
Automated + browser pass on http://localhost:3010 — Listed tab shows sign-in or zero property rows (no Ballard/Brooklyn seed names).

## Expected
Seeded properties visible after `npm run test:seed` on dev Supabase.

## Acceptance
- [ ] Listed tab shows seed properties OR clear “run test:seed” dev hint
- [ ] ADD / Add property affordance visible
EOF
)"

run_ticket \
  --title "[Infra] Restart dev server after sandbox:pin — client still redirects to :3000" \
  --project "01 — Infrastructure & Ops" \
  --milestone "Dev environment" \
  --priority 4 \
  --labels "Improvement,qa:audit" \
  --body "$(cat <<'EOF'
## Context
`npm run sandbox:pin -- 3010` updates NEXT_PUBLIC_APP_URL but auth redirects keep landing on :3000 until `npm run dev -- -p 3010` is restarted.

## Expected
Document in portal QA script + pin script output that restart is mandatory; optional dev-server health check on review port.

## Related
PRP-170 (partial fix). This is the operator footgun on cursor-1 review.
EOF
)"

run_ticket \
  --title "[Listings] Gate MTM and Custom surcharge rows on lease lengths" \
  --project "10 — Listings & Properties" \
  --milestone "Pricing & rooms" \
  --priority 3 \
  --labels "Feature,area:listings,portal:manager" \
  --body "See docs/linear/manifests/cursor-1-sep3-2026-tickets.md section A1."

run_ticket \
  --title "[Listings] Bill OTHER FEES only when fee checkbox is enabled" \
  --project "10 — Listings & Properties" \
  --milestone "Pricing & rooms" \
  --priority 2 \
  --labels "Bug,area:listings,portal:manager,area:payments" \
  --body "See docs/linear/manifests/cursor-1-sep3-2026-tickets.md section A2."

run_ticket \
  --title "[Listings] Default OTHER FEES + remove rollover MTM checkbox" \
  --project "10 — Listings & Properties" \
  --milestone "Create wizard" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "See docs/linear/manifests/cursor-1-sep3-2026-tickets.md section A3."

run_ticket \
  --title "[Listings] Bathroom step — fixtures, no whole-house, no auto type" \
  --project "10 — Listings & Properties" \
  --milestone "Create wizard" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "Implemented on cursor-1 — verify on :3010 and close. See manifest B1."

run_ticket \
  --title "[Listings] Wizard ADD rows — rooms, bathrooms, shared spaces" \
  --project "10 — Listings & Properties" \
  --milestone "Create wizard" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "Implemented on cursor-1 — verify on :3010 and close. See manifest B2."

echo "Done. Run: npm run linear:triage"
