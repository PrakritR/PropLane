# Listing wizard: the Default card

The **Pricing** step of the v2 listing wizard
(`src/components/portal/listing-wizard-v2/listing-editor.tsx`,
`listing-pricing-step.tsx`) has no Default room card (PLAN-0922-1159). Rooms,
Bathrooms, Shared spaces and Pricing are each their own record. "Same as
Room X" on Pricing copies another room's **price card** once
(`copyRoomPricingFrom`); on Rooms it copies the **description**
(`copyRoomDescriptionFrom`). Neither pick is a live link.

`houseDefaults` and `houseTermPricing` remain on the submission so an older
listing still opens priced: the wizard shell fills blank followers once
(`fillRoomsFollowingDefaults`) and autosaves. The public listing, the preview
rail, the assistant and the resident's move-in page still read
`room.monthlyRent` / `room.termPricing` / `room.photoDataUrls` exactly as
before. `bathroomDefaults` and `sharedSpaceDefaults` are legacy — see below.

Library: `src/lib/listing-house-defaults.ts`. `roomsFollowingDefaults` is the
older per-record reading the previous (non-v2) wizard still uses.

## Rooms, Bathrooms and Shared spaces are each their own record

All three steps draw one card per record and nothing above them: name (or a
fixed type on Bathrooms), Duplicate, ✕ and the chevron; the important rows are
on the card, everything else waits behind one More ▾. None of the three has a
Default card, a "This … only · Reset" tick, a per-row Reset, or "Make all the
same" — every value a record carries is its own, so Review, the public
listing and the lease read exactly what the card shows.

- **Rooms**: Residents per room (not on a whole-place listing), Bathroom
  access, Floor on the card; Furnishing (with Beds and Included while
  furnished), Room amenities, Size, Photos, Video, Description, Availability,
  move-in checklists, move-in instructions, entry photos and arrival clip
  behind More ▾. Adding a room makes the same blank the Basics bedroom count
  makes (`emptyRoom`) with one resident and no name — no seeding from another
  room. Like a bathroom, a blank card SHOWS the listing's ground floor
  (`floorLevelSelectOptions(listingStoriesId, "")[0]`) on its Floor row and in
  its summary line, and writes one only when the manager picks.
- **Bathrooms**: Floor, Type and Finishes on the card; Who uses it (unless
  whole-place or no rooms yet); Description, Photos and Video behind More ▾.
  Adding a bathroom — and every card the Basics bathroom count makes — is a
  full bath with no rooms assigned and NO floor written: the Floor control
  shows the listing's ground floor
  (`floorLevelSelectOptions(listingStoriesId, "")[0]`) as a display default
  and writes one only when the manager picks. A stamped floor reads as a
  filled-in card to `isBathroomSlotRemovable`, and lowering the count would
  then refuse forever.
- **Shared spaces** (PLAN-0920-0631): Type, Floor and Who may use it on the
  card; What is in it, Size (sq ft, `sizeSqft`, like a room's — labelled "Lot
  size" for an outdoor space), Description, Photos and Video behind More ▾. A
  new space starts on the ground floor with Everyone allowed and everything
  else blank. "Who may use it" is Everyone as an empty `roomAccessIds` (a list
  naming every current room reads the same,
  `src/lib/listing-shared-space-access.ts`).

Guards: `tests/unit/listing-shared-spaces-no-default.test.ts`,
`tests/unit/listing-rooms-bathrooms-no-default.test.ts`.

## "Same as Room X" / "Same as Bathroom X": a one-time copy, nothing stored

The first row an open Rooms or Bathrooms card unfolds is **Same as**
— a pick of "—" plus every other room's (or bathroom's) name. Picking one
copies that record onto this one **once, right now**
(`copyRoomDescriptionFrom` / `copyBathroomDescriptionFrom`) — never a standing
link, so editing either record afterward simply makes them stop matching.
Pricing no longer shows Same as (PLAN-0922-1904). Duplicate on Rooms still
copies the price card with `copyRoomPricingFrom`. The picker's own value is
derived fresh on every render, never stored: it reads back whichever other
record this one still equals (`roomDescriptionMatches` /
`bathroomDescriptionMatches`), or "—" when none does.
**A Rooms or Bathrooms card that describes nothing yet always reads "—"**
(`roomDescriptionIsBlank` / `bathroomDescriptionIsBlank`): every record is
minted identical, so matching a sibling by value there would announce a copy
that never happened.

The description fields a room's copy touches are exactly
`ROOM_DESCRIPTION_FIELDS` — floor, beds, occupancy, furnishing, room
amenities, size, the two move-in checklists, photos, video, description,
move-in instructions, entry photos, arrival clip. It never touches `id`,
`name`, `availability`, `moveInAvailableDate`, `manualUnavailableRanges`, any
price or per-resident-pricing field, or `ownRoomFields` itself. A bathroom's
copy is the same idea over `BATHROOM_INHERIT_FIELDS` (floor, type, finishes,
description, photos, video) and never touches `id`, `name`, `assignedRoomIds`,
`allResidents`, `accessKindByRoomId` or the access kind — who uses a bathroom
survives every copy untouched.

Pricing's copy is `ROOM_PRICING_FIELDS` — rent, utilities, deposit, listed
rent, partial-month rates, stay rates, and `termPricing` (price-card fields
only). It never copies fees, per-resident slots, `rentBasis` or
`dailyRentPrice`. A one-room listing hides the row.

`room.ownRoomFields` still records which fields a hand edit or a "Same as"
copy last touched (kept for whatever else reads it), but nothing in the Rooms
step reads it back any more — there is no card left for a field to "follow"
or "detach from".

Guards: `tests/unit/listing-same-as-copy.test.ts` (the pure functions),
`tests/unit/listing-rooms-bathrooms-no-default.test.ts` (the picker, live).

## `bathroomDefaults` and `sharedSpaceDefaults` are legacy readers

Both blocks are read-only now. A listing saved while the Default bathroom or
Default shared space card existed still carries its block; the normaliser
keeps it and `bathroomDefaultsForSubmission` / `sharedSpaceDefaultsForSubmission`
still read it (the address-prefill path fills a blank record from it on an
older listing), but neither wizard step draws or writes either block again.
Every record always held its own copy of every value, so an old listing reads
exactly as before.

## Fees live on the card that charges them

There is no separate "Other fees" section on Pricing and no More ▾ on its
cards: every room card, on every lease tab, lists its fees and adds one in
place (`FeeRows`, `listing-pricing-step.tsx`). A fee added on a room is
scoped to it. A fee with no `roomIds` (older listings, or the whole place)
still reaches every room. The tab it is added on sets `leaseTypes`: the lease
types from a lease tab, the stay types from a stay tab (`feeScopeForTab`),
stored only when that narrows what the listing offers. A room lists the
house-wide fees that reach it read-only ("· all rooms"). Typing a standard
fee's name (Parking, Holding deposit…) adopts that preset row, so billing and
the lease document see the same record they always did. Same `customFees`
records, no new storage.

## The application fee follows one amount, per lease type

The Applications card sits directly under the lease-types card.
`applicationFee` is the one amount; `applicationFeeByLeaseType` (keyed by the
displayed lease type) holds only the types priced differently, behind
"Different application fee per lease type". A blank row follows the one
amount. `shortTermApplicationFee` is the legacy stay fallback and mirrors the
Short-term row. `listingApplicationFeeRaw(listing, rentalType, leaseTerm)`
(`src/lib/listing-application-fee.ts`) is the one reader; the applicant's
fee preview and checkout send the chosen lease term as a selector and the
server still resolves the amount from the stored listing.

## Another lease type is the room's own `termPricing`

On a lease type other than long-term (Month-to-Month, Custom), a room follows
its long-term numbers until it writes `room.termPricing[term]` (absent =
same as long-term, PRP-463). "Same as long-term" clears every room's entry on
that term and any leftover `houseTermPricing` block so an older listing does
not reopen as own. The receipt, the public quote and `resolveStayPricing`
read the room, not a house default. `houseTermPricingForSubmission` still
infers a stored block from rooms for older listings.

## Counts make the cards

Basics' Bedrooms count makes the room cards (`applyListingBedroomSlots`) and
its Bathrooms count makes the bathroom cards (`applyListingBathroomSlots`).
A half count rounds up to a card; the card the half adds is a half bath while
the count says so and an untouched card goes back to a shower bath when the
count becomes whole. Lowering a count removes untouched cards from the end
and, when the last card has been filled in, keeps the cards and moves only
the number. A new listing starts with one bathroom card.

## Availability is a list of occupied dates, never a typed status

A room is **available by default**. The Rooms step's Availability block
(`listing-wizard-v2/occupied-dates.tsx`) lists only the spans that close it:
the manager's own rows in `manualUnavailableRanges` (Start → End, End may be
`null` for "no end date"), plus read-only rows for residents' stays, Bookings
blocks and Airbnb imports. There is no Available/Occupied switch and nothing
in the block prints what renters see: the round + in the header adds a row, a
dashed footer under the rows adds the next one, and the calendar toggle shows
the same spans on a month grid
(`src/components/room-availability-month-calendar.tsx`, shared with the public
listing page). `src/lib/room-availability-timeline.ts` is still the one
derivation of the renter-facing label, and every change writes the derived
`availability` and `moveInAvailableDate` alongside the ranges so old readers
keep working. A room saved with only a future `moveInAvailableDate` reads as
occupied until the day before. Airbnb rows are identified by their id prefix and
are never edited here — the calendar sync owns them. Availability is per room and
never inherits from a Default card.

Spec: `tests/unit/room-availability-timeline.test.ts`,
`tests/unit/listing-wizard-v2-occupied-dates.test.tsx`.

## Inputs that hold a draft

`SizeInput` (rooms) and `MoneyInput` (pricing) show what was typed while
focused and commit on every keystroke and again on blur. Rendering the model's
formatted string mid-typing put the caret in front of the digits on iOS and,
when the round trip was lost, showed nothing. The size placeholder is a dash,
never a number.

**No money row carries an example amount.** A `MoneyInput`'s placeholder is the
figure it actually inherits — the long-term term's, or nothing — never a
made-up "1,100" or "50", because a manager reads a greyed number as a value
the listing already holds. So a new listing opens Pricing entirely blank, with
"Charge an application fee" unticked until the manager turns it on — only a
listing that already stores a fee, a per-type amount, the legacy stay fee or
a waiver code opens ticked (PRP-499,
`tests/unit/listing-pricing-blank-defaults.test.tsx`).

Specs: `tests/unit/listing-wizard-v2-cards.test.tsx`,
`tests/unit/listing-wizard-v2-rooms-all-rooms.test.tsx`,
`tests/unit/listing-pricing-screen-behaviour.test.tsx`,
`tests/unit/listing-application-fee.test.ts`,
`tests/unit/listing-wizard-v2-basics-bathrooms.test.tsx`,
`tests/unit/listing-house-defaults.test.ts`,
`tests/unit/listing-record-defaults.test.ts`,
`tests/unit/listing-shared-spaces-no-default.test.ts`,
`tests/unit/listing-rooms-bathrooms-no-default.test.ts`,
`tests/unit/listing-same-as-copy.test.ts`.

## Secondary Rooms fields stay behind one More ▾

Furnishing, Room amenities, Size, Photos, Video, Description, Availability,
the move-in checklists, move-in instructions, entry photos and arrival clip
all sit behind Rooms' one More ▾, and a column label's ⓘ opens one line on
tap — never a sentence printed under the label. `ManagerRoomSubmission.ownRoomFields`
(`manager-listing-submission.ts`) still records which description fields a
hand edit or a "Same as Room X" copy last touched, kept only because it is a
persisted field other code may still read; nothing in the Rooms step reads it
back any more now that there is no top card for a field to follow or detach
from (PLAN-0921-1648 retired the "All rooms" card and its checkbox —
`SameAsAllToggle` is unused on Pricing now that Same as is a Room X pick).

## Partial months (PLAN-0920-0423)

"Partial months" lives on each room card: an **Automatic** checkbox
(`prorateMethod` blank/`auto`) that, unticked (`daily_rate`), reveals one /day
row per line that prorates — Rent /day, Utilities /day only while utilities
are above $0, and one row per monthly fee above $0 on that card
(`ListingFeeRow.dailyRate`). The Pricing tick is the stored `residentPricing === "per_resident"` flag
(`roomStoresPerResidentPricing`), even when every resident rent is still $0.
`roomPricesPerResident` stays the headline predicate so a $0 split room never
prints "from $0/mo." When **Different rent per resident** is on,
Partial months moves inside each Resident N block and writes
`residentPrices[n].prorateMethod` / daily rates (PLAN-0922-1748). Charges and
the lease read that slot via `resolveRoomProrationForSlot` and
`roomResidentPriceForSlot`. A house-wide fee
from an older listing still lists on every room card as an inherited row: ✕
takes it off that room only (`roomIds` = every other room), typing splits a
room-only copy (labelled "<Fee> – <Room>" when the label is a preset's,
because the normalizer recovers a preset from its exact label), and Reset
folds it back. Specs: `listing-pricing-screen-behaviour.test.tsx` ("partial
months"), `listing-pricing-step-per-resident.test.tsx`,
`listing-wizard-v2-cards.test.tsx` ("a house-wide fee on a room card").

## Short-stay rent per resident (PLAN-0922-1748)

On Short stay / Airbnb, a two-or-more-resident room has a **Rent per
resident** dropdown: Same for every resident / Different per resident
(`stayResidentPricing` / `stayResidentPrices`). Different opens Resident 1 /
2 with Rent /night and Rent /week. Independent of the long-term checkbox.
