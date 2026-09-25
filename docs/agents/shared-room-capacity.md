# Shared-room capacity

A room's capacity defaults to one, with an explicit integer range of 1–20. Each independently approved application occupies one bed and retains its own rent, lease and charges. Pending applications reserve nothing. Whole-property placements occupy every bed. Occupancy uses peak simultaneous stays with inclusive end dates, manual dates before application dates, and open-ended stays when no end is known.

`20260906070000_shared_room_capacity.sql` installs the authoritative database guard. Application placement writes and listing capacity edits serialize through an actual property-row revision update, then count using a fresh PostgreSQL command snapshot. At repeatable-read isolation, stale competing writes fail with a serialization error. API conflicts return 409; the browser awaits confirmed approval before publishing an approved row, generating charges or starting approval automation. No refused approval creates local charges or welcome messages.

`20260920234000_resident_slot_arbitration.sql` extends the same guard to a per-resident room's rent SLOT, not just its bed count: `resolveApprovedResidentSlot` (`src/app/api/manager-applications/route.ts`) is a read-then-write pick of which slot is open, which is not on its own safe against two concurrent approvals landing on the identical slot even when total bed capacity is not exceeded. `assert_room_placement_capacity` now re-checks slot uniqueness from the same serialized write + fresh snapshot as the bed count, keyed on the application's own stored `application.residentSlot`, and raises the same P4001 -> 409 a second approval of a full room already gets. The check is gated on the room still showing a per-resident pricing signal (room-level or any lease term) so a `residentSlot` left over from a room later switched to flat pricing can never manufacture a false conflict.

Move-out amendments commit the application dates and unsigned replacement lease together through `commit_room_lease_extension`. A final renewal signature reserves its dates in the same database transaction, so lost capacity rolls the signature back. A server-owned `occupancy_start` floor preserves the current stay when a future renewal signs early, independent of renewal billing dates. The floor survives application ID normalization and resets only on an actual owner/property/room transfer. Billing awaits persistence and leaves a failed renewal pending for retry.

An iCal guest stay (Airbnb / Booking.com, not a "Not available" / "Blocked" summary) is one Current resident and one bed. Typed blocks and leases occupy a bed the same way. `src/lib/occupancy/snapshot.ts` (`occupancyForDay`) is the occupancy reader Bookings, apply, listing Available, and the export ICS all format over — never a second `rooms.length` count.

The public availability endpoint publishes anonymous room/count spans from approved placements of public listings, plus each channel stay and typed block as a one-bed span, scoped to their current owner. It contains no resident identities or application IDs. It paginates placement reads, aggregates whole-property reservations, sends CDN cache headers, and replaces cached snapshots instead of unioning stale rows. Client snapshots expire after 60 seconds, are cleared on private application changes/account switches, and are ignored in demo mode. Concurrent forced loads use the shared coalesced refresher.

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

The apply wizard's first choice lists each bed when the room prices per
resident (`Room 9 · Resident 1 · $1,050/mo`). The value is
`propertyId::roomId::rN`; `parseRoomChoiceValue` strips the slot so occupancy
and the public snapshot still key on `propertyId::roomId`. Second and third
choices stay room-level. Taken beds show as disabled "Taken"; a pending
application does not reserve a bed. Submit stores `residentSlot` plus the
slot's rent/utilities/deposit overrides. The apply "What a resident pays"
card and Review housing charges read `buildListingQuote` with that slot, so
they match the listing sidebar. Approval still arbitrates the last bed (409).

Specs: `tests/unit/room-pricing-per-resident.test.ts`,
`tests/unit/manager-listing-submission-resident-prices.test.ts`,
`tests/unit/listing-house-defaults-resident-pricing.test.ts`,
`tests/unit/listing-fees-resident-slots.test.ts`,
`tests/unit/listing-fees-display-applicant-slot.test.ts`,
`tests/unit/rental-application-room-options.test.ts`,
the per-resident case in `tests/unit/listing-quote.test.ts`, and the
per-resident case in `tests/unit/public-listing-projection.test.ts`.

Validation includes real two-client PostgreSQL races, stale snapshot refusal, capacity reductions, disjoint stays, metadata upserts, atomic amendment rollback, renewal reservation and transfer semantics in `tests/integration/database/shared-room-capacity.test.ts`. Run against an explicitly chosen disposable local cluster with `ROOM_CAPACITY_TEST_PORT=55439 npx vitest run tests/integration/database/shared-room-capacity.test.ts`; the test creates and drops only its own random database. The migration is applied to dev/test. Staging and production follow the normal release ladder.

`room_placement_room` (the SQL mirror of `parseRoomChoiceValue`) must strip the same `::rN` resident-slot suffix the JS side does before matching a room id — `20260925010000_room_placement_slot_suffix_fix.sql` fixed it splitting on only the FIRST `::`, which turned a per-resident `propertyId::roomId::r1` choice into the unmatchable room id `roomId::r1` and raised a false "Assigned room no longer exists." on every approval of a per-resident-priced room. The strip is conditional on a genuine third segment (`choice ~ '::.*::r[0-9]+$'`) so a two-segment `propertyId::roomId` is never mistaken for a suffixed value merely because the room id itself starts with `r` followed by digits.
