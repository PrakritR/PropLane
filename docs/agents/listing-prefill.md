# Address prefill (auto-fill a new listing from its address)

Read this before changing `src/lib/listing-prefill/`, the two routes under
`src/app/api/portal/listing-prefill*` or the `FoundOnlineCard` on the Basics
step. Plan: `PLAN-0914-2208`.

## What it does

When a manager picks an address from the Street address dropdown on the
Basics step, a card appears under it:

- **Facts** for the home (type, beds, baths, square feet, year built, floors,
  lot, and the amenities a record carries: heating, AC, garage parking) plus a
  **rent estimate** with a range. "Use these details" fills the step.
- **An earlier public ad** for the address is pointed at ("Your Craigslist ad
  from Aug 12?" with a link). "Paste it" opens a box; the manager pastes the
  ad's text and "Import" fills headline, description, extra amenities and the
  pet rule. The rent the ad quoted is shown on the Pricing step, never set.
- Every field the card wrote carries a `✦ Filled` / `✦ Imported` mark and
  "Undo" restores the exact previous values (`submission.prefill.previous`).

## Invariants

1. **Facts come only from the licensed records provider (RentCast).** Its API
   terms allow storing and displaying what it returns. No other property data
   source is wired in.
2. **PropLane never fetches a listing page.** Zillow, Redfin, Realtor,
   Apartments.com, Craigslist and Facebook all forbid automated reads
   (Craigslist's terms set $3,000 a day in damages) and listing photos carry
   per-image statutory damages. The earlier-ad search reads a search index
   (Tavily) and returns site, title, date, snippet and link. The extract route
   accepts pasted **text only** and makes no request beyond the model call.
   Photos are never imported from another site; the manager adds their own.
3. **Only a field still at its default is written.** A value the manager typed
   is never overwritten and never marked. `apply.ts` is pure and tested.
4. **Nothing sets the rent.** The estimate and the ad's price are reference
   lines on the Pricing step (`RentEstimateLine`).
5. **`prefill` and `yearBuilt` are manager-only.** `houseSizeSqft` and
   `lotSizeSqft` are public facts; `prefill` (what was filled and from where)
   and `yearBuilt` (a compliance input) are deliberately not on
   `PUBLIC_SUBMISSION_KEYS` — `tests/unit/public-listing-projection.test.ts`
   pins the latter.
6. **`yearBuilt` gates the federal lead-paint disclosure.** A prefilled year is
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
- The extract route does not spend a lookup.

## Configuration

| Env | Effect |
| --- | --- |
| `RENTCAST_API_KEY` | Enables the feature. Absent → the route answers `unavailable` and the card never renders. |
| `TAVILY_API_KEY` | Enables the earlier-ad search. Absent → no ad is offered; facts still fill. |
| `ANTHROPIC_API_KEY` | Model-backed extraction of pasted text. Absent → the heuristic reader in `extract-ad.server.ts`. |
| `LISTING_PREFILL_PROVIDER=fixture` | Deterministic local facts and a fixture ad for development and e2e. Refused when `VERCEL_ENV=production`. A street containing "nowhere" answers "no record". |

RentCast: free tier 50 requests/month for development; $74/month for 1,000
(≈ 500 new-address prefills at two calls each). Keys live in Vercel for
staging and production, never in the repo.

## Files

- `src/lib/listing-prefill/types.ts` — shapes, `prefillAddressKey`.
- `src/lib/listing-prefill/records.server.ts` — RentCast client + fixture.
- `src/lib/listing-prefill/prior-ad.server.ts` — search-index pointer + fixture.
- `src/lib/listing-prefill/extract-ad.server.ts` — pasted text → fields.
- `src/lib/listing-prefill/apply.ts` — pure apply / undo / marks / offline draft.
- `src/lib/listing-prefill/quota.server.ts` — cache + monthly quota.
- `src/app/api/portal/listing-prefill/route.ts`, `src/app/api/portal/listing-extract-ad/route.ts`.
- `src/components/portal/listing-wizard-v2/found-online-card.tsx` — the card and `FieldMark`.
- `supabase/migrations/20260915010000_listing_prefill.sql`.
- Tests: `tests/unit/listing-prefill-apply.test.ts`, `tests/unit/listing-prefill-route.test.ts`.

## Analytics

PostHog `listing_prefill_looked_up` {found, cached, priorAd, quota?} and
`listing_ad_text_imported` {fields, source}. No addresses, URLs or text in
payloads. The extract and "Write a description" calls run under
`traceAgentTurn`.
