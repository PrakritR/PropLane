# Address prefill (auto-fill a new listing from its address)

Read this before changing `src/lib/listing-prefill/`, the route under
`src/app/api/portal/listing-prefill` or the `FoundOnlineCard` on the Basics
step. Plans: `PLAN-0914-2208`, `PLAN-0915-1947`.

## What it does

When a manager picks an address from the Street address dropdown on a
**blank** listing, a card appears under it listing every entry the click will
fill, one row each: home type, bedrooms (and the rooms they make), rent per
room, bathrooms (and the bathroom cards they make), shared spaces, size, year
built, floors, lot, amenities, and the rent estimate as a reference row.
"Use these details" writes exactly those rows. Every field written carries a
`✦ Filled` mark (`✦ Estimated` on a rent, `✦ Imported` on what the property
import wrote) and "Undo" restores the exact previous values
(`submission.prefill.previous`), cards included.

## Invariants

1. **The card comes up only on a blank listing.** `listingIsBlankForPrefill`:
   no home type, the bedroom stepper at 1 with a single untouched room, no
   bathroom count, no size, no year built. City, ZIP, name and description do
   not count. A listing that fails the gate never shows the card and never
   spends a lookup; once the click has filled it, the card stays (with Undo).
2. **What the card lists is exactly what the click writes.** `prefillEntries`
   is derived from the patch `applyFactsToSubmission` builds — never a
   separate list. A row never appears for something that would not fill.
3. **Facts come only from the licensed records provider (RentCast).** Its API
   terms allow storing and displaying what it returns. No other property data
   source is wired in, and no second search runs beside the lookup.
4. **PropLane never fetches or searches for a listing page.** Zillow, Redfin,
   Realtor, Apartments.com, Craigslist and Facebook all forbid automated reads
   (Craigslist's terms set $3,000 a day in damages) and listing photos carry
   per-image statutory damages. The earlier-ad pointer and paste-to-import
   were removed in `PLAN-0915-1947`; do not bring a listing-site read back.
5. **Only a field still at its default is written.** A value the manager typed
   is never overwritten and never marked. `apply.ts` is pure and tested.
6. **An estimate fills only an empty rent, marked `✦ Estimated`.** A by-the-room
   home gets the estimate split per bedroom (`rentPerRoomFromEstimate`, nearest
   $10) onto the Default room and every room the click made; a whole-place home
   gets the estimate as its rent. A rent anyone already set is never touched.
   The estimate itself stays a reference line on the Pricing step
   (`RentEstimateLine`).
7. **Shared spaces are a default, not a fact.** A by-the-room home with no
   shared spaces gets Kitchen & dining and Living / lounge cards from the
   Default shared space; a whole-place home gets none. The records provider
   knows nothing about shared spaces.
8. **`prefill` and `yearBuilt` are manager-only.** `houseSizeSqft` and
   `lotSizeSqft` are public facts; `prefill` (what was filled and from where)
   and `yearBuilt` (a compliance input) are deliberately not on
   `PUBLIC_SUBMISSION_KEYS` — `tests/unit/public-listing-projection.test.ts`
   pins the latter.
9. **`yearBuilt` gates the federal lead-paint disclosure.** A prefilled year is
   marked for the manager to check like every other field; an absent year stays
   absent (unknown), never defaulted.

## Quota and cache

- One lookup per address the manager PICKS (never per keystroke).
- `listing_prefill_cache`: one row per normalized address, 30 days, no account
  data (retained on purge). A repeat address costs nothing.
- `listing_prefill_usage`: lookups per manager per calendar month. Free plan:
  `FREE_PLAN_MONTHLY_LOOKUPS` (3); Pro and Business uncapped. The plan is read
  through `getEffectiveManagerSkuTier` and an unreadable plan is reported as
  `error`, never treated as Free or unlimited.
- A listing that fails the blank-listing gate never calls the route at all.

## Configuration

| Env | Effect |
| --- | --- |
| `RENTCAST_API_KEY` | Enables the feature. Absent → the route answers `unavailable` and the card never renders. |
| `LISTING_PREFILL_PROVIDER=fixture` | Deterministic local facts for development and e2e. Refused when `VERCEL_ENV=production`. A street containing "nowhere" answers "no record". |

RentCast: free tier 50 requests/month for development; $74/month for 1,000
(≈ 500 new-address prefills at two calls each). Keys live in Vercel for
staging and production, never in the repo.

## Files

- `src/lib/listing-prefill/types.ts` — shapes, `prefillAddressKey`.
- `src/lib/listing-prefill/records.server.ts` — RentCast client + fixture.
- `src/lib/listing-prefill/apply.ts` — pure gate / entries / apply / undo / marks / offline draft.
- `src/lib/listing-prefill/quota.server.ts` — cache + monthly quota (the cache's `prior_ad` column is legacy, no longer read or written).
- `src/app/api/portal/listing-prefill/route.ts`.
- `src/components/portal/listing-wizard-v2/found-online-card.tsx` — the card and `FieldMark`.
- `supabase/migrations/20260915010000_listing_prefill.sql`.
- Tests: `tests/unit/listing-prefill-apply.test.ts`, `tests/unit/listing-prefill-route.test.ts`.

## Analytics

PostHog `listing_prefill_looked_up` {found, cached, quota?}. No addresses in
payloads. The "Write a description" call runs under `traceAgentTurn`.
