# Shared-room capacity

A room's capacity defaults to one, with an explicit integer range of 1–20. Each independently approved application occupies one bed and retains its own rent, lease and charges. Pending applications reserve nothing. Whole-property placements occupy every bed. Occupancy uses peak simultaneous stays with inclusive end dates, manual dates before application dates, and open-ended stays when no end is known.

`20260906070000_shared_room_capacity.sql` installs the authoritative database guard. Application placement writes and listing capacity edits serialize through an actual property-row revision update, then count using a fresh PostgreSQL command snapshot. At repeatable-read isolation, stale competing writes fail with a serialization error. API conflicts return 409; the browser awaits confirmed approval before publishing an approved row, generating charges or starting approval automation. No refused approval creates local charges or welcome messages.

Move-out amendments commit the application dates and unsigned replacement lease together through `commit_room_lease_extension`. A final renewal signature reserves its dates in the same database transaction, so lost capacity rolls the signature back. A server-owned `occupancy_start` floor preserves the current stay when a future renewal signs early, independent of renewal billing dates. The floor survives application ID normalization and resets only on an actual owner/property/room transfer. Billing awaits persistence and leaves a failed renewal pending for retry.

The public availability endpoint publishes anonymous room/count spans from approved placements of public listings, scoped to their current owner. It contains no resident identities or application IDs. It paginates placement reads, aggregates whole-property reservations, sends CDN cache headers, and replaces cached snapshots instead of unioning stale rows. Client snapshots expire after 60 seconds, are cleared on private application changes/account switches, and are ignored in demo mode. Concurrent forced loads use the shared coalesced refresher.

## Rent per resident (PLAN-0920-0631)

A room whose capacity is 2 or more may price each resident on its own. The
listing keeps this on the room, no migration: `residentPricing: "per_resident"`
plus `residentPrices`, one row per slot (index + 1 = slot number) carrying
`monthlyRent` and optional `utilitiesEstimate`, `securityDeposit`,
`pricingMode`. Each `termPricing[term]` entry may carry the same two fields, so
a lease type prices its own residents; a term saying nothing follows long-term,
and a term saying `"same"` turns the row off for that type only.
`ManagerRoomResidentPrice` in `src/lib/manager-listing-submission.ts` is the
type; the fields are documented there.

Normalization (`reconcileRoomResidentPricing`, run by
`normalizeManagerListingSubmissionV1` and pure for the Pricing card) is the
one place the rules live: rows are clamped to `occupancyCapacity` (extras
truncated, missing rows padded from the last row, else from the room's own
figures), a blank or zero rent falls back to the room's — or the term's —
rent, and at capacity 1 both fields drop while the room's own figures stay.
`"same"` is never stored on the room. A per-resident room is its OWN room for
the Pricing step's Same-as-default-room tick on rent, utilities and deposit
(`roomHasResidentPricing`, `src/lib/listing-house-defaults.ts`); a default
change never reaches it and Reset (`resetRoomFieldToDefault`) unticks it.
The Default card never carries these fields.

`src/lib/room-pricing.ts` is the only reader: `roomPricesPerResident(room,
term?)`, `roomResidentPrices(room, term?)` (always one entry per bed, the
room's own figures when the row is off), `roomResidentPriceForSlot`,
`roomLowestResidentRent`, `roomResidentRentLines`. The headline
(`roomHeadlineAmount` / `roomHeadlinePriceLabel`) is the LOWEST slot rent
printed `from $800/mo`, and every aggregate (`roomMonthlyEquivalent`) ranks on
it. Monthly rooms only — see the interaction rule in `docs/agents/rent-basis.md`.

A slot is a price, not a person. Who holds a slot lives on the application
(the approval pick writes the resident's own rent and deposit overrides, which
`resolveStayPricing` already ranks first, plus the slot number); the public
projection (`publicListingProjection`) carries `residentPricing` and the money
keys of `residentPrices` and nothing else. A fee can be scoped to a slot with
`ListingFeeRow.residentSlots` (absent = every resident of the fee's rooms, like
`roomIds`), read through `feeAppliesToResidentSlot`, which also applies when
the slot is unknown so a fee is never dropped for want of a number.

Specs: `tests/unit/room-pricing-per-resident.test.ts`,
`tests/unit/manager-listing-submission-resident-prices.test.ts`,
`tests/unit/listing-house-defaults-resident-pricing.test.ts`,
`tests/unit/listing-fees-resident-slots.test.ts`, and the per-resident case in
`tests/unit/public-listing-projection.test.ts`.

Validation includes real two-client PostgreSQL races, stale snapshot refusal, capacity reductions, disjoint stays, metadata upserts, atomic amendment rollback, renewal reservation and transfer semantics in `tests/integration/database/shared-room-capacity.test.ts`. Run against an explicitly chosen disposable local cluster with `ROOM_CAPACITY_TEST_PORT=55439 npx vitest run tests/integration/database/shared-room-capacity.test.ts`; the test creates and drops only its own random database. The migration is applied to dev/test. Staging and production follow the normal release ladder.
