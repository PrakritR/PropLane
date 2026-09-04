#!/usr/bin/env bash
# File captain-requested Linear tickets (cursor-1 session, 2026-09-03).
# Lavish plans come AFTER this batch — do not run lavish:plan until all PRP ids exist.
#
# Requires LINEAR_API_KEY in .env.local
#
# Usage:
#   bash scripts/linear-file-cursor1-sep3-batch.sh           # create all
#   bash scripts/linear-file-cursor1-sep3-batch.sh --dry-run # preview JSON only
#
# Manifest: docs/linear/manifests/cursor-1-sep3-2026-tickets.md

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
fi

PROJECT_LISTINGS='10 — Listings & Properties'
MS_CREATE='Create wizard'
MS_PRICING='Pricing & rooms'

run_ticket() {
  if ((${#DRY[@]})); then
    npm run linear:ticket -- --dry-run "$@"
  else
    npm run linear:ticket -- "$@"
  fi
}

echo "=== 10 — Listings & Properties → Pricing & rooms ==="

run_ticket \
  --title "[Listings] Gate MTM and Custom surcharge rows on lease lengths" \
  --project "$PROJECT_LISTINGS" \
  --milestone "$MS_PRICING" \
  --priority 3 \
  --labels "Feature,area:listings,portal:manager" \
  --body "$(cat <<'EOF'
## User story
As a manager adding a listing, I only see **Month-to-month surcharge** and **Custom lease** surcharge in OTHER FEES when the matching lease length is selected.

## Current behavior
Surcharge rows are hidden behind “+ Add fee” or always visible; not tied to **Month-to-Month** / **Custom** under Lease lengths.

## Expected behavior
- **Month-to-Month** checked → surface MTM surcharge row; uncheck → hide and stop billing.
- **Custom** checked → surface Custom lease surcharge row; uncheck → hide and stop billing.
- Legacy `allResidents` / rollover checkbox must not gate this UI.

## Portal / route
Manager listing wizard → Pricing step (`/portal` add/edit listing).

## Acceptance criteria
- [ ] MTM surcharge row appears only with Month-to-Month lease length
- [ ] Custom lease surcharge row appears only with Custom lease length
- [ ] Unchecking lease length hides row and clears billing for new saves
- [ ] Unit tests for gating helpers
- [ ] Manual walkthrough on localhost:3010

## Source
Captain chat + Lavish DRAFT plan assets (lease-lengths screenshot). **Lavish plan after ticket filed.**
EOF
)"

run_ticket \
  --title "[Listings] Bill OTHER FEES only when fee checkbox is enabled" \
  --project "$PROJECT_LISTINGS" \
  --milestone "$MS_PRICING" \
  --priority 2 \
  --labels "Bug,area:listings,portal:manager,area:payments" \
  --body "$(cat <<'EOF'
## User story
Optional OTHER FEES (application, move-in, holding, parking, etc.) must create resident charges **only when the manager enabled that fee row**, not because a dollar amount exists while unchecked.

## Current behavior
`household-charges.ts` and related paths read listing scalars / preset amounts even when the wizard checkbox is off.

## Expected behavior
- Unchecked fee row → no charge at application approval / lease signing.
- Checked row with amount (including \$0) → follows existing validation rules.
- Persist enabled state via `removedStandardListingFeeRows` + toggle normalization on save.

## Portal / route
Manager listing wizard → Pricing; charge creation on approve/sign.

## Acceptance criteria
- [ ] Application fee, move-in, holding, parking, HOA, other monthly respect toggle state
- [ ] Regression test: nonzero legacy amount + unchecked box → no charge
- [ ] Manual: approve application with only Application fee checked

## Source
Captain screenshot (OTHER FEES checkboxes). **Lavish plan after ticket filed.**
EOF
)"

run_ticket \
  --title "[Listings] Default OTHER FEES + remove rollover MTM checkbox" \
  --project "$PROJECT_LISTINGS" \
  --milestone "$MS_CREATE" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "$(cat <<'EOF'
## User story
New listings should start with a minimal OTHER FEES table; managers add optional fees explicitly. Remove the “Continue month-to-month when the lease ends” wizard control.

## Current behavior
Move-in/cleaning and other fees appear by default for some listings. Rollover MTM checkbox on Pricing step sets `rolloverToMonthToMonth`.

## Expected behavior
- New listing OTHER FEES: **Application fee** (+ rent) visible by default only.
- Move-in/cleaning, holding deposit, parking, HOA, other monthly → add via “+ Add fee”.
- Remove rollover MTM checkbox from wizard UI; new saves leave field unset (legacy rows unchanged).

## Portal / route
Manager listing wizard → Pricing.

## Acceptance criteria
- [ ] `DEFAULT_HIDDEN_STANDARD_LISTING_FEE_ROW_IDS` includes move-in with holding/parking/HOA/other monthly
- [ ] Rollover checkbox removed from `manager-add-listing-form.tsx`
- [ ] Lease HTML still sane for legacy `rolloverToMonthToMonth: true` rows
- [ ] Unit tests updated

## Source
Captain Lavish feedback (Sep 3, 2026). **Lavish plan after ticket filed.**
EOF
)"

echo ""
echo "=== 10 — Listings & Properties → Create wizard ==="

run_ticket \
  --title "[Listings] Bathroom step — fixtures, no whole-house, no auto type" \
  --project "$PROJECT_LISTINGS" \
  --milestone "$MS_CREATE" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "$(cat <<'EOF'
## User story
Bathroom setup should list real fixtures without auto-labeling full/half bath or a whole-house toggle.

## Current behavior (pre-fix on cursor-1)
Whole-house bathroom checkbox; only shower/toilet/tub fixtures; collapsed row showed Full/Half bath derived label.

## Expected behavior
- Remove **Whole-house bathroom** checkbox; use **All rooms** under Used by rooms for shared baths.
- Fixtures: Shower, Toilet, Bathtub, **Sink**, **Mirror** (listing tags include enabled fixtures).
- No auto **Full bath** / **Half bath** / **En-suite** label on collapsed row.
- Quick-add tiles preset fixtures but name rows **Bathroom N** (not Full/Half/En-suite).

## Implementation note
Land on cursor-1 branch; verify before close.

## Acceptance criteria
- [ ] UI matches above on Bathrooms step
- [ ] Public listing bathroom tags show Sink/Mirror when checked
- [ ] Unit tests pass (`listing-wizard-step-redesign`, bathroom layout)

## Source
Captain screenshot + chat. **Lavish plan after ticket filed.**
EOF
)"

run_ticket \
  --title "[Listings] Wizard ADD rows — rooms, bathrooms, shared spaces" \
  --project "$PROJECT_LISTINGS" \
  --milestone "$MS_CREATE" \
  --priority 4 \
  --labels "Improvement,area:listings,portal:manager" \
  --body "$(cat <<'EOF'
## User story
Rooms, Bathrooms, and Shared spaces steps use the same simple **blue-outlined ADD** row as Properties — no duplicate optional copy.

## Current behavior (pre-fix on cursor-1)
Shared spaces had two “Optional…” paragraphs plus “Or pick one above…” under ADD. Rooms/bathrooms used outline buttons at top/bottom.

## Expected behavior
- Remove repetitive optional intro copy on Shared spaces.
- **ADD ROOM**, **ADD BATHROOM**, **ADD SHARED SPACE** via `PortalListAddRow` with blue solid border (`ListingWizardListAddRow`).
- No hint line under ADD (“Or pick one above…”).
- Template tiles (kitchen, laundry, bathroom type shortcuts) remain; only footer ADD changes.

## Implementation note
Land on cursor-1 branch; verify before close.

## Acceptance criteria
- [ ] All three steps use matching ADD row
- [ ] No duplicate optional paragraphs on Shared spaces
- [ ] `listing-wizard-step-redesign.test.ts` updated

## Source
Captain screenshots (Shared spaces step). **Lavish plan after ticket filed.**
EOF
)"

echo ""
if [[ ${#DRY[@]} -gt 0 ]]; then
  echo "Dry run complete — no issues created."
else
  echo "Batch complete. Next:"
  echo "  1. Paste PRP ids into docs/linear/manifests/cursor-1-sep3-2026-tickets.md"
  echo "  2. Captain reviews tickets in Linear"
  echo "  3. THEN: npm run lavish:plan per ticket (not before)"
fi
