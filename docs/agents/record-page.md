# Record pages — the Residents standard (PLAN-0921-1029, area 1)

Every record a portal shows (manager, resident, vendor) renders through
`PortalRecordDetailPage` with the registry entry from `record-sections.ts`
and the overview kit from `portal-record-overview-kit.tsx`. No kind hand-rolls
its own shell.

1. Header: back chevron · initials tile · title · subtitle. Actions are icons
   only (`PortalIconAction`): one filled primary — the section's next step —
   plus at most three outline icons. The word is the tooltip and aria-label.
   The set is per (role, kind, SECTION): the icons change as you move between
   a record's sections, because the action you want changes with them.
2. Desktop keeps the left section card: the kind's own sections first, then
   the linked trio (Payments · Communication · Documents · Activity).
3. Overview = four `StatTile`s · a `RecordNeedsYou` list (hidden when empty) ·
   `RecordFactCard`s in two columns, each with a "Section →" link. A fact is a
   label/value row (`RecordFactRow`). Status is a value, never a pill. A card
   whose body is a list of records (Payments, a linked record) is a
   `RecordRowsCard` instead — same shell, rows of title/sub-line/figure with
   an optional dashed "+ &lt;label&gt;" footer row.
4. No footer, and no toolbar. `PortalRecordDetailPage` has no `footer` prop;
   the phone has no sticky action bar; a section body never grows its own row
   of buttons (a document viewer shows version/page facts, not controls).
   The one exception is the commit button inside a sheet or dialog.
   Guard: `tests/unit/record-page-no-footer.test.ts` also fails a labelled
   `<button>` rendered inside a record section body.
5. No checkbox in a record. A room, a step, a signature is a row with a state
   glyph; state changes inside the row's sheet or ⋯.
6. Phone: same header and content; the section chips are replaced by
   `PortalRecordSectionPicker` — a dropdown listing the sections, `+` expands
   a section's sub-tabs, a row navigates, Close closes.
7. Communication inside a record renders the record's thread(s) and a
   composer only. Never the inbox chrome.
8. Money: Payments on every kind lists the charges whose `recordRef` is this
   record, with an "Add charge" footer row.
9. Lists: one entry row everywhere (`portal-entry-row.tsx`) — tile, title,
   place line, up to three glyph facts, a right-hand figure, and ⋯. Attention
   is a dot; lateness is a red figure; there are no pills and no inline
   buttons. Grouping and sorting come from `list-grouping.ts` through the one
   header control, sort applies inside groups, and the choice lives in the URL.
10. A section earns a tab only if it is opened in normal use. Everything else
    is a card on Overview with a link, a header icon, or content inside
    another section. Activity is never a tab: it is the last Overview card,
    three most recent events plus "All activity →". The registry's `groups`
    for a kind is the whole tab list — adding one is a decision, not a
    default.

## What wave 1 (area 1a of this plan) actually landed

Points 1–6 above are live. `pro-resident-overview-panel.tsx` is the reference
implementation of point 3 and renders unchanged pixel-for-pixel — every other
kind's Overview still needs its own `record-overview-*.tsx` built from the
kit (point 3 for those kinds), points 7–10 (Communication as a thread only,
Payments-by-`recordRef`, the shared entry row, and re-scoping which sections
each kind actually keeps) are later-wave work. Until they land, most kinds'
own tab content is unchanged from before this plan, and `phonePrimary` no
longer exists — the phone has no sticky action of its own to prime.

## Header actions are per (role, kind, section)

`recordSections(role, kind, ctx, activeSectionId?)` resolves `headerActions`
for the section actually open, via each kind's `sectionActions` map, falling
back to the kind's default set when the active section has no entry of its
own (or when a caller omits `activeSectionId` altogether, which every
call site still does as of wave 1 — the mechanism is in place, not yet wired
end to end). `headerActions` render as `PortalIconAction ring` (40px circle,
first one filled) via `PortalRecordHeaderIconActions`, published through the
existing `PortalRecordDetailPage iconTitleActions` slot, hidden below `lg`
exactly as before.

## Known gap

Not every action id has a real handler yet — an unwired one shows "Coming
soon" rather than a silent no-op. Property and Resident keep their own
already-working header actions instead of the registry's generic set, so real
functionality it does not cover 1:1 yet is never dropped. Bookings'
`record-payment` header action is a narrower case: it is dropped from the
header entirely (never rendered, never "Coming soon") on any booking without a
verified charge path, per the plan's own "omit — never Coming soon" rule for
that one id. Payment's header (`record-payment`, `send-reminder`, `delete`) is
fully wired in `pro-payments-ledger-panel.tsx` through the same reversible
paths the row ⋯ menu uses; it has no `edit` — amount edits stay in the row ⋯
menu's Edit dialog — and `record-payment` is omitted when nothing is left to
pay.

A handful of records with real, business-logic-heavy action rows moved off
the removed `footer` prop onto `PortalRecordActions` directly rather than
through the registry: applications (`renderApplicationRowActions` /
`renderCosignerDetailActions`, already icon-only), team/co-manager links
(`pro-account-links-panel.tsx`, now icon-only), and — unconverted, still
labelled buttons, deferred to the wave that redesigns those features —
background-check screening actions (`application-screening-panel.tsx`),
add-on service request actions (`pro-service-request-detail.tsx`), and lease
actions (`LeasePrimaryHeaderActions`). Those three still publish into the
header via `PortalRecordActions` exactly as they did as a `footer`, so no
behavior changed; making them icon-only is per-kind panel work, not shared
shell.

## The day page pattern

A calendar's day cell is a page, not a pop-up (`/portal/bookings/<yyyy-mm-dd>`, PLAN-0920-1058 area 1e) —
`src/components/portal/bookings-day-page.tsx`. Rows group by the record's own grouping key (property, for
Bookings) and open the record page directly; there is no day-detail modal and no assistant chip in its header.
Any future "what happened on this day" screen (Tasks, Inspections) should follow the same shape rather than a
bespoke pop-up.
