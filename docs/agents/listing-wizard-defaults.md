# Listing wizard: the Default card

The **Pricing** step of the v2 listing wizard
(`src/components/portal/listing-wizard-v2/listing-editor.tsx`,
`listing-pricing-step.tsx`) is the only step left with a Default card: its two
top cards are the Default room, one per lease type. Rooms, Bathrooms and
Shared spaces have no Default card (PLAN-0921-1648 finished what PLAN-0920-0631
started for Shared spaces) — every record there is its own, full stop, and
"Same as Room X" / "Same as Bathroom X" is the one way a record starts from
another's description (see below).

## The Default card is a card, not a record

A record still carries its own copy of every value. The Default card is what
the top card shows on reopen, never a source a reader downstream resolves:
the public listing, the preview rail, the assistant and the resident's move-in
page read `room.photoDataUrls`, `room.moveInInstructions` and so on exactly as
before. One optional block on the submission holds it
(`houseDefaults`, `src/lib/manager-listing-submission.ts`); an older listing
without it infers the card from its rooms (`houseDefaultsForSubmission`).
`bathroomDefaults` and `sharedSpaceDefaults` are the same idea for bathrooms
and shared spaces, but both are legacy now — see below.

## A room follows the Pricing Default card **per field**

- A field follows when its value equals the Default card's or is empty. Lists
  (photos) compare by value.
- Changing one field on a room makes **only that field** the room's own.
  A room on its own floor still takes a new default size, amenities or
  checklist. The step remembers hand edits per field for the session, so a
  value set while the Default card was still blank is not swept up by the
  first default.
- Unticking "Same as default room" is the one whole-record freeze; Reset (per
  row, or ↺ under the name) copies the Default card back, blanks included
  (`resetRoomFieldToDefault`) — never blank the room, because Review, the
  applicant's room list and the signed lease read the record, not the card. A
  listing opened with a blank follower on rent, utilities or deposit is filled
  from the card once (`fillRoomsFollowingDefaults`, in the wizard shell) and
  autosaved.
- There is no "Make all the same" button anywhere in the wizard any more
  (PLAN-0921-1648 removed the last one with the Rooms and Bathrooms Default
  cards); the per-record tick and Reset above are the only way back to the card.
- Pictures, clips and words are a record's own the moment it has any while the
  Default card has none (`LISTING_HOUSE_DEFAULT_MEDIA_FIELDS`); a fact keeps
  the older rule, where the first default fills the blanks.
- Inference: facts take the most common value; a photo list or clip is
  inferred only when **every** record carries the same one.

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

The first row an open Rooms or Bathrooms card unfolds is **Same as** — a pick
of "—" plus every other room's (or bathroom's) name. Picking one copies that
record's description onto this one **once, right now**
(`copyRoomDescriptionFrom` / `copyBathroomDescriptionFrom`,
`src/lib/listing-house-defaults.ts` / `src/lib/listing-record-defaults.ts`) —
never a standing link, so editing either record afterward simply makes them
stop matching. The picker's own value is derived fresh on every render, never
stored: it reads back whichever other record this one's description still
equals (`roomDescriptionMatches` / `bathroomDescriptionMatches`), or "—" when
none does. **A card that describes nothing yet always reads "—"**
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
cards: every card — Default room or a room, on every lease tab — lists its
fees and adds one in place (`FeeRows`, `listing-pricing-step.tsx`). A fee
added on the Default room (or the whole place) is every room's — stored with
no `roomIds`, how "All rooms" was always stored; one added on a room is
scoped to it. The tab it is added on sets `leaseTypes`: the lease types from a
lease tab, the stay types from a stay tab (`feeScopeForTab`), stored only when
that narrows what the listing offers. A room lists the house-wide fees that
reach it read-only ("· all rooms"). Typing a standard fee's name (Parking,
Holding deposit…) adopts that preset row, so billing and the lease document
see the same record they always did. Same `customFees` records, no new
storage.

## The application fee follows one amount, per lease type

The Applications card sits directly under the lease-types card.
`applicationFee` is the one amount; `applicationFeeByLeaseType` (keyed by the
displayed lease type) holds only the types priced differently, behind
"Different application fee per lease type". A blank row follows the one
amount, the way a room follows the Default room. `shortTermApplicationFee` is
the legacy stay fallback and mirrors the Short-term row.
`listingApplicationFeeRaw(listing, rentalType, leaseTerm)`
(`src/lib/listing-application-fee.ts`) is the one reader; the applicant's
fee preview and checkout send the chosen lease term as a selector and the
server still resolves the amount from the stored listing.

## The Pricing Default room has a per-term twin

On a lease type other than long-term (Month-to-Month, Custom), the Pricing
step's Default room is `sub.houseTermPricing[term]`, shaped like a room's
`termPricing` entry: rent, utilities, deposit. Same rules as above — a room
follows the term default per field when its entry is absent or equal, a
different number is the room's own, and a cleared default drops the field from
every following room so it falls back to long-term. "Same as long-term" clears
the term default and every room's entry on that term. Rooms still carry their
own copy in `room.termPricing[term]` (absent = same as long-term, PRP-463), so
the receipt, the public quote and `resolveStayPricing` read nothing new. A
listing saved before the card existed infers it per term from its rooms
(`houseTermPricingForSubmission`).

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
never inherits from the Default card.

Spec: `tests/unit/room-availability-timeline.test.ts`,
`tests/unit/listing-wizard-v2-occupied-dates.test.tsx`.

## Inputs that hold a draft

`SizeInput` (rooms) and `MoneyInput` (pricing) show what was typed while
focused and commit on every keystroke and again on blur. Rendering the model's
formatted string mid-typing put the caret in front of the digits on iOS and,
when the round trip was lost, showed nothing. The size placeholder is a dash,
never a number.

**No money row carries an example amount.** A `MoneyInput`'s placeholder is the
figure it actually inherits — the Default card's, the long-term term's, or
nothing — never a made-up "1,100" or "50", because a manager reads a greyed
number as a value the listing already holds. So a new listing opens Pricing
entirely blank, with "Charge an application fee" unticked until the manager
turns it on — only a listing that already stores a fee, a per-type amount, the
legacy stay fee or a waiver code opens ticked (PRP-499,
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
`SameAsAllToggle` is Pricing's alone now).

## Partial months (PLAN-0920-0423)

"Partial months" is a Default-card field like rent: an **Automatic** checkbox
(`prorateMethod` blank/`auto`) that, unticked (`daily_rate`), reveals one /day row
per line that prorates — Rent /day, Utilities /day only while utilities are above
$0, and one row per monthly fee above $0 on that card (`ListingFeeRow.dailyRate`).
A room follows the card until touched and Resets by copying. A Default-card fee is
listed on every room card as an inherited row: ✕ takes it off that room only
(`roomIds` = every other room), typing splits a room-only copy (labelled
"<Fee> – <Room>" when the label is a preset's, because the normalizer recovers a
preset from its exact label), and Reset folds it back. Specs:
`listing-pricing-screen-behaviour.test.tsx` ("partial months"),
`listing-wizard-v2-cards.test.tsx` ("a house-wide fee on a room card").
