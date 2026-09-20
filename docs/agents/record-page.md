# The record page (PLAN-0920-1058, area 1a)

One shape for every record a portal shows — manager, resident, and vendor.

## The registry, not a hand-built rail

`src/lib/portals/record-sections.ts` exports `recordSections(role, kind, ctx?)` → `{ groups, headerActions,
phonePrimary?, phonePrimaryLabel? }` — the one place a record's rail, header icons, and phone primary action
come from. Never hand-roll a `groups`/`items` pair; feed the registry's output to `PortalRecordSectionChrome`.
`tests/unit/record-sections-registry.test.ts` guards it: every href resolves to a real route, ids are unique,
the trio never comes before a kind's own sections.

## The shared trio

The registry **always** appends `communication` (every kind); `documents` and `activity` only where that
kind's row shows them (Task and Tour skip documents; several resident/vendor kinds skip both). Callers never
add these themselves. Content comes from `src/components/portal/record-section-renderers.tsx`
(`registerRecordSectionRenderer` / `renderRecordSection`); `communication` is a placeholder registration until
area 1b lands the real thread list.

## Phone chrome

Below `lg`, the chrome renders `PortalRecordSectionChips` (filled current chip, no sub-line) instead of the
rail, plus a bottom-fixed sticky bar (`phonePrimary` + a `⋯` for the rest). Mounting it hides the native
bottom nav (`src/lib/portal-record-page-chrome.ts`) — never two fixed bars at once.

## Header icons

`headerActions` render as `PortalIconAction ring` (40px circle, first one filled) via
`PortalRecordHeaderIconActions`, published through the existing `PortalRecordDetailPage iconTitleActions`
slot, hidden below `lg`.

## Known gap

Not every action id has a real handler yet — an unwired one shows "Coming soon" rather than a silent no-op.
Property and Resident keep their own already-working header actions instead of the registry's generic set, so
real functionality it does not cover 1:1 yet is never dropped. Bookings' `record-payment` header action is a
narrower case: it is dropped from the header entirely (never rendered, never "Coming soon") on any booking
without a verified charge path, per the plan's own "omit — never Coming soon" rule for that one id.

## The day page pattern

A calendar's day cell is a page, not a pop-up (`/portal/bookings/<yyyy-mm-dd>`, PLAN-0920-1058 area 1e) —
`src/components/portal/bookings-day-page.tsx`. Rows group by the record's own grouping key (property, for
Bookings) and open the record page directly; there is no day-detail modal and no assistant chip in its header.
Any future "what happened on this day" screen (Tasks, Inspections) should follow the same shape rather than a
bespoke pop-up.
