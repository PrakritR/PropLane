# Listing wizard: the Default card

The Rooms, Bathrooms and Shared spaces steps of the v2 listing wizard
(`src/components/portal/listing-wizard-v2/listing-editor.tsx`) each start with
one **Default** card — "Default room", "Default bathroom", "Default shared
space" — and one card per record. The Pricing step's two top cards are the
same Default room.

## The Default card is a card, not a record

A record still carries its own copy of every value. The Default card is what
the top card shows on reopen, never a source a reader downstream resolves:
the public listing, the preview rail, the assistant and the resident's move-in
page read `room.photoDataUrls`, `room.moveInInstructions` and so on exactly as
before. Three optional blocks on the submission hold the cards
(`houseDefaults`, `bathroomDefaults`, `sharedSpaceDefaults`,
`src/lib/manager-listing-submission.ts`); an older listing without them infers
each card from its records (`houseDefaultsForSubmission`,
`bathroomDefaultsForSubmission`, `sharedSpaceDefaultsForSubmission`).

## A record follows the Default card **per field**

- A field follows when its value equals the Default card's or is empty. Lists
  (photos) compare by value.
- Changing one field on a record makes **only that field** the record's own.
  A room on its own floor still takes a new default size, amenities or
  checklist. The step remembers hand edits per field for the session
  (`useOwnFields`), so a value set while the Default card was still blank is
  not swept up by the first default.
- Unticking "Same as default …" is the one whole-record freeze; Reset (per
  row, or ↺ under the name) copies the Default card back, blanks included.
  The Pricing step's tick and ↺ do the same (`resetRoomFieldToDefault`) —
  never blank the room, because Review, the applicant's room list and the
  signed lease read the record, not the card. A listing opened with a blank
  follower on rent, utilities or deposit is filled from the card once
  (`fillRoomsFollowingDefaults`, in the wizard shell) and autosaved.
- "Make all the same" overwrites every record and asks first when a record has
  its own photos or clip.
- Pictures, clips and words are a record's own the moment it has any while the
  Default card has none (`LISTING_HOUSE_DEFAULT_MEDIA_FIELDS`); a fact keeps
  the older rule, where the first default fills the blanks.
- Inference: facts take the most common value; a photo list or clip is
  inferred only when **every** record carries the same one.

Library: `src/lib/listing-house-defaults.ts` (rooms),
`src/lib/listing-record-defaults.ts` (bathrooms and shared spaces).
`roomsFollowingDefaults` is the older per-record reading the previous wizard
still uses; the v2 Rooms step does not call it.

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

Specs: `tests/unit/listing-wizard-v2-cards.test.tsx`,
`tests/unit/listing-pricing-screen-behaviour.test.tsx`,
`tests/unit/listing-application-fee.test.ts`,
`tests/unit/listing-wizard-v2-basics-bathrooms.test.tsx`,
`tests/unit/listing-house-defaults.test.ts`,
`tests/unit/listing-record-defaults.test.ts`.
