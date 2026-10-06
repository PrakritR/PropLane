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
   the shared trio (Communication · Documents · Activity). The trio's group is
   always unlabeled — it reads as universal record chrome, not a category.
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
   a section's sub-tabs, a row navigates, Close closes. A property is the
   exception (`phoneTabs`): its sections are underline command tabs, which on a phone (< 640px) are that
   same dropdown picker because ten of them cannot share one screen, and its header is Edit + one ⋯
   (Share, Unlist, Duplicate, Delete, Email) so the name keeps one line (`PropertyPhoneHeaderActions`).

   **Any tab strip that does not fit one phone screen is the dropdown picker there** (captain, 2026-10-06):
   inside a record page or a pop-up (`PhoneStripPickerScope`, provided by `PortalRecordDetailPage`, `Modal`
   and `AddWorkspace`) every command strip (`DestinationNav` / `LocalDestinationNav`, `appearance="command"`)
   and the wizard's step tabs (`WizardStepTabs`) draw `PhoneStripPicker` instead of a sideways-scrolling row
   when `phoneStripFits` says the labels need more than ~336px. A strip that fits stays tabs, the strip
   stays in the DOM (hidden below `sm`), and from 640px up nothing changes. Not converted: the listing
   page's in-page section jump bar (`listing-detail-subnav.tsx`), which is scroll-spy navigation, not a tab strip.
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

## A property has no Activity

A property record does not carry Activity (`hasActivity: false` on the manager/property registry entry): it is not
in the rail, the phone picker, `PROPERTY_DETAIL_TABS` or the Activity band of `pro-house-properties-panel.tsx`.
An old `/portal/properties/<stage>/<id>/activity` URL parses to Preview (`parsePropertyDetailTab`). Resident,
vendor and every other kind keep their Activity. Guard: `tests/unit/property-redesign-round2.test.tsx`.

## Property sections split by stay

Applications, Leases, Move-in forms, Services and AI info draw **Long term / Short term** tabs from one helper,
`src/lib/property-stay-tabs.ts`: a stay's tab exists when the property allows the stay (Airbnb counts as short
term), a row for both stays shows in both tabs as one record, and a stay the property does not allow still keeps
its tab when it holds rows of the manager's own (never hide data); an untouched PropLane short-stay default on a
long-term-only property is `offered: false` / `stayHidden` and holds no tab. A stay's default is a row inside its
list (a star **Default** fact + **Set as default for <stay>** in the other rows' menus), not a tab. Promotion stays
one list. Guard: `tests/unit/property-stay-tabs.test.ts`.

## What wave 1 (area 1a of this plan) actually landed

Points 1–6 above are live. `pro-resident-overview-panel.tsx` is the reference
implementation of point 3 and renders unchanged pixel-for-pixel — every other
kind's Overview still needs its own `record-overview-*.tsx` built from the
kit (point 3 for those kinds), points 7–10 (Communication as a thread only,
Payments-by-`recordRef`, the shared entry row, and re-scoping which sections
each kind actually keeps) are later-wave work. Until they land, most kinds'
own tab content is unchanged from before this plan, and `phonePrimary` no
longer exists — the phone has no sticky action of its own to prime.

## Manager resident record (2026-10-05)

Rail: RESIDENT (Overview · Tours · Application · Background check), HOME (Lease · Forms · Move in ·
Payments · Services, current residents only · Documents · Communication, last). No Activity tab;
Inspections is a Move in sub-tab (`/move-in/inspections`, and an old `/inspections` link redirects
there). Forms is owned by [`move-in-forms.md`](move-in-forms.md) § Manager Forms page.

The record's top-right icons are **Edit and Delete, and nothing else**, identical on every tab: the
one `PortalRecordActions` in `pro-residents.tsx` publishes them from the registry's tab-independent
`headerActions`, and no tab body may publish a second set (the slot is single, last wins). Everything
that used to crowd that corner is an action of the tab it belongs to — Message is Communication's
composer, Share · Archive (· Send invite, when there is no login yet) are the Overview tab's ⋯,
Send application is Application's blue +, and Documents has only its own + (Add document) — "Upload
for resident" is a second door on that pop-up's "Start from a file" card ("Read a filled application
or lease"), not a header icon of its own.

**A tab header shows only what applies to its open sub-tab, and there is no ⋯ in it (2026-10-06).** An action
that does not apply is absent, never disabled. Application: Incomplete = Remind · Edit · Send application;
Pending = Reject · Edit · Download · Approve; Approved = Download · Send lease; Rejected = Download · Move to
pending · Delete application (a rejection can be taken back, and the delete confirms first). Lease:
Draft = Edit · Send lease; Resident signature = Remind; Manager signature = Sign; Signed = Download. Payments:
Pending / Overdue = Remind · +; Paid = Download. Background check = Run check / Run new check. Tours: the + on
Scheduled and Upcoming, nothing on Past, and the Settings gear (the one way into tour rules). Forms: the + on Pending only. "Upload completed application" is the
"Start from a file" card inside the Send application pop-up (`ShareLeadLinkModal`'s
`onUploadCompletedApplication`), not a menu item. The sets live in `residentSectionHeaderActions`
(`src/lib/resident-record-section-actions.ts`, pure; `pro-residents.tsx` only handles the ids it
returns). Guard: `tests/unit/resident-record-section-actions.test.ts`.

A tab's own actions are icons in its section header card: `ManagerResidentSectionToolbar` carries
**no section name** (the rail already says which section is open) — only the tabs as
`destinationRow` on the left, then icon actions, the blue + last. Application is
Incomplete · Pending · Approved · Rejected (`residentApplicationStatusBucket`); Background check is
ONE tab, Completed, counting only a report that came back —
`residentBackgroundCheckCompletedCount` lets the ORDER's own status decide whenever there is one
(any conclusion counts, `review` included; a `failed` / `canceled` order never does), and consults
the derived `backgroundCheckStatus` only when there is no order at all, for a result a manager
recorded by hand. Never `applicationShowsBackgroundCheck`, which says a check merely APPLIES. Its
body keeps rendering the panel, so a pending check still shows its true status; Lease follows its sub-tab
(above); Documents
draws its kinds (Application · Lease · Payments · Inspections · Other) as that same header card's
tabs, never a second control row. Move in's sub-tabs are Placement · Move-in details · Roommates ·
Inspections, opening on Placement, and an unrecognised sub-tab slug lands there too
(`parseResidentRecordMoveInTab`); `/move-in/forms` redirects to the record's own Forms item.

Placement and Move-in details resolve from the record's OWN application row, never every row sharing
the email, or an approved tenancy at another property describes this one. Roommates is a server read,
issued only while that sub-tab is open and never summarised as a tab count:
`GET /api/manager-applications/<id>/housemates` authorizes **twice** — the record with
`managerCanAccessApplicationRecord`, then the property re-derived from the stored row with the same
helper but `manager_user_id` omitted, because the row's property id is writable by the manager who
owns that record and the frozen stamp must not stand in for owning the property. It then answers
through the resident loader, so each peer is redacted by that peer's own sharing preferences and the
manager sees no more than the resident does. A failed read is an error whose retry is the only
forced read, hands its promise to the Button, and is dropped if the manager moved to another record
before it landed — never "no residents", and never a dead-end "loading".

## Header actions are per (role, kind, section)

`recordSections(role, kind, ctx, activeSectionId?)` resolves `headerActions`
for the section actually open, via each kind's `sectionActions` map, falling
back to the kind's default set when the active section has no entry of its
own (or when a caller omits `activeSectionId` altogether, which most call
sites still do). Resident, Property and Tasks pass the open tab and so get
the per-section set. `headerActions` render as `PortalIconAction ring`
(40px circle, first one filled) via `PortalRecordHeaderIconActions`, published through the
existing `PortalRecordDetailPage iconTitleActions` slot, hidden below `lg`
exactly as before.

## Known gap

Not every action id has a real handler yet — an unwired one shows "Coming
soon" rather than a silent no-op. Property keeps its own already-working
header actions instead of the registry's generic set, so real functionality it
does not cover 1:1 yet is never dropped. Resident now builds from the
registry's `headerActions` and only amends it per section
(`pro-residents.tsx`): the leasing sends splice in ahead of Delete,
approve/decline drop unless the application still awaits a decision,
`run-check` becomes "Run new check" once a check exists, and the consent
reminder is prepended on the Background check tab. Bookings'
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
background-check screening actions (`application-screening-panel.tsx`) and lease
actions (`LeasePrimaryHeaderActions`). Those still publish into the
header via `PortalRecordActions` exactly as they did as a `footer`, so no
behavior changed; making them icon-only is per-kind panel work, not shared
shell. A service record (add-on and maintenance alike) is converted: Message · Edit · ⋯ · ONE labeled
primary (`portalLabeledPrimarySpec`), see `services-system.md`.

## The day page pattern

A calendar's day cell is a page, not a pop-up (`/portal/bookings/<yyyy-mm-dd>`, PLAN-0920-1058 area 1e) —
`src/components/portal/bookings-day-page.tsx`. Rows group by the record's own grouping key (property, for
Bookings) and open the record page directly; there is no day-detail modal and no assistant chip in its header.
Any future "what happened on this day" screen (Tasks, Inspections) should follow the same shape rather than a
bespoke pop-up.
