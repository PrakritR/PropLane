# Captain UI queue — 2026-09-04 night session

Linear refused every new issue tonight ("You've exceeded the free issue limit
for this workspace"), so these are recorded here instead. Move them to Linear
once the workspace has room.

## Done this session

| Item | Where |
| --- | --- |
| Whole house is a checkbox (select-all rooms, indeterminate on partial) | Move-in tab |
| Bulk bar left-justified, "1 selected" dropped | Move-in tab |
| Room filter removed | property Bookings tab |
| Week nav + day/date row stick while scrolling | property Tours tab |
| Grid scrolls past the pinned footer instead of stopping under it | property Tours tab |
| Delete removed from the bulk bar; single `Edit <thing>` action | Application, Lease, Services, Promotion |
| Selection clears when the editor closes | same four tabs |

## Also open, smaller

* **Phone asked for twice.** A number set in Settings → Profile should not be
  asked for again in Messaging; account creation should ask permission to use it
  for SMS instead.
* **Stored ids still say AXIS.** Display is fixed everywhere (localhost and
  production, no data change). The stored values on pre-rebrand accounts, and
  the seed fixtures for the canonical test accounts, still mint `AXIS-`.
  Renaming them is a migration: lease ids and charge references derive from that
  id, and the fixtures cross-reference each other, so they move together or not
  at all. Production rows are not something to rewrite without a plan.
* **Tasks settings dropdowns clip.** Fixed the text overflow; a menu opened near
  the bottom of a tall modal can still render past the panel edge.

## Redesigns the captain asked for — these need plans, not late-night edits

Each of these is a section-sized rebuild rather than a fix, and several change
what the product DOES, not just how it looks. Recorded here so none of them are
lost; none are started.

* **Vendors — new UI, end to end.** The captain's words: "it is honestly very
  confusing." Today Teams → Vendors is a toolbar of Vendor catalog / Defaults
  over an empty dashed box, and Defaults is a modal of settings that should be
  reachable some other way. Wants a coherent surface for the whole vendor
  concept: directory, catalog, defaults, dispatch, invoices, payouts.
* **Finances — cut to Income and Expenses, nothing else.** Two tabs, CSV export,
  grouped by property, checkbox table. Everything else goes for now.
* **Documents — cut to uploaded documents.** Drop the tax and other categories;
  keep applications/leases and anything uploaded, sorted by property, with
  checkbox download and a plain upload path.
* **Bookings calendar — a colour per resident, no names.** Every booking shown as
  its resident's colour; click a day for the detail (room, resident, property).
  Day / week / month / year views.
* **Tours — Add availability, left of Share tour.** Opens the calendar as a
  popup with drag-to-select availability and a property dropdown at the top.
* **Detail pages become popups.** Service, payment and lease details open as
  modals with their actions at the bottom, in the shape Edit lease now has.
* **Payments grouped into tasks.** Several payments for the same resident on the
  same day should become ONE task, not five. Same grouping idea as the reminder
  fix, one layer up.
* **A Services category in Tasks settings.** Needs a real trigger (which service
  event creates the task) before the category means anything.

## Still open from tonight's queue

* **"24 reminders scheduled" for one resident** — the SEND side is fixed (one
  message per person). The SCHEDULE side is not: 6 charges × 4 reminder times
  still creates 24 scheduled rows. Same fix, one layer down — group the
  projection by recipient and date so a resident with several payments due the
  same day gets one scheduled message, not one per charge.
* **Payment generation timing** — application fee on submission; lease-signing
  charges on approval; rent/utilities once the lease is signed; custom deposits
  and fees at their own points, each with the right reminders. Substantial, and
  it changes what a resident is billed and when, so it wants its own plan.
* **Payments tab: Pending / Overdue / Paid** on the resident detail Payments tab
  (the portfolio Payments page already has them).
* **Services settings** on the resident Services tab — needs defining: what
  would it configure that the property-level service catalog does not?
* **Send via should stay openable even when only one channel is available** —
  today it collapses to a disabled Email with a hint about adding a work number.
* **Background-check report card** — the dark panel uses a different type scale
  from the rest of the portal, and several tiles render the literal string
  "null" where a value is missing. The "null" is a bug, not a style issue.
* **Share background check** — held deliberately. The only share we have mints
  an unauthenticated public link that lives 90 days with no revoke; pointing one
  at a consumer report is a privacy decision, not a UI one.

## Open

### Property-first settings & edit (Lavish plan open for review)

Leases and Applications both get an **Edit** button beside **Settings**, and all
four entry points ask which property first — single select, Continue — before
opening anything. One shared picker step, not four. Skipped when the manager has
one property, and when the property is already known from context.

Also: an **Application settings** entry at the bottom of the property Application
tab carrying Auto-approve applications, scoped to that house.

Three questions in the plan need the captain's answer before it moves: whether
Edit lease opens the house's lease TEMPLATES or a tenant's actual lease; whether
auto-approve living in two places reads and writes one per-property value; and
whether these buttons belong in the toolbar (as screenshotted) or the footer dock
(as every other property detail tab does it).

Plan: `scratchpad/property-first-settings-plan.html` (Lavish).

* **View application** — a click-through preview of exactly what a resident
  sees, navigable end to end without filling anything in. Lives in the Edit
  application popup (alongside Edit and Delete), and on the Application tab.
* **Assistant panel wastes the modal's right column** — Edit application:
  transcript is clipped at the top, composer sits mid-column, roughly half the
  height below it is blank while the question list scrolls in a short viewport.
  The transcript should grow so the composer sits at the bottom.
* **"There should be no such thing as work orders, just services"** — needs a
  decision on scope before anyone starts. See below.

## Work orders → services: what the decision costs

`AGENTS.md` currently defines these as two deliberately separate models:

* **Add-on services** — `ServiceRequest` rows in `portal_service_request_records`
  (parking, storage, resident-purchasable offerings).
* **Work orders** — `portal_work_order_records` (maintenance and repair), with
  vendor dispatch, bidding, invoicing and Connect payouts hanging off them.

Two readings of the instruction, very different in size:

1. **Vocabulary only** — nothing user-visible says "work order"; the tables,
   tools and routes keep their names. Days, low risk, reversible.
2. **One model** — merge the two tables, tool catalogs, agent registries, nav
   counts and the whole vendor pipeline onto one concept. Weeks, touches the
   SMS agents, the payout anchor and the confirm gate.

Reading 1 is a subset of reading 2, so it is safe to start there either way.

## Found while implementing the admin + vendor redesigns (Sep 4)

Each of these is a real defect found in the code, not a styling preference.
Listed newest first; the ones already fixed say so.

### Fixed

* **The vendor availability editor was mounted nowhere.** `VendorAvailabilityEditor`
  was exported from `vendor-settings-panel.tsx` and rendered by no page, so a
  vendor could not set weekly hours, open a one-off date, or block one — the
  whole availability feature was unreachable from the product. It now has a
  pane in the vendor Settings rail.
* **`/admin/communication` redirected to a folder that no longer existed.** The
  section's own nav href pointed at `/communication/inbox/unopened` while the
  panel had stopped reading which folder was in the URL, so all five tabs
  rendered the same view. Collapsed to one inbox; legacy paths still resolve.
* **The Free-plan "+ Add property" button had become a dead click.** At the cap
  it was rendered `disabled`, so the one moment the product has to explain the
  limit and offer the upgrade passed in silence. Restored to a live button that
  refuses and says why — the same rule as the sidebar's `upsell` nav lock.
* **Resident and vendor Communication grew a third segment.** Active / Unread /
  Archived, where the manager inbox — the stated reference — has two, and
  `AGENTS.md` says one inbox with no folder tabs. Unread is a filter, not a
  folder. Removed the tab; the `/unread` URL still resolves.
* **A build-breaking import and two non-narrowing Sets.**
  `use-unified-communication-bulk` imported `unarchiveManagerSmsConversation`,
  which does not exist (`restoreManagerSmsConversation` is the module's
  inverse), and two payments clusters built a charge-id `Set` through
  `.filter(Boolean)`, which does not narrow away `undefined`.

### Open

* **Vendor Payments never names the manager who owes the money.** `managerName`
  is not a field on the vendor work-order row at all, so `row.managerName` is
  always `undefined`: demo prints the canonical "Test Manager" on every row and
  production prints "Property manager" on every row. Fixing it means threading
  the manager through the vendor work-order read — a data change, not a label
  one. Until then the vendor cannot tell two managers' invoices apart.
* **`pro-unified-inbox.tsx` carries a dead third segment.** Its internal
  toolbar renders Active / Unread / Archived, but the only caller
  (`pro-communication.tsx`) passes `listChrome="external"`, so that branch never
  runs. Harmless today; the moment someone passes `internal` they get an inbox
  that disagrees with every other one. Delete the branch or drop its Unread
  entry.
* **Vendor Communication has no filter sheet.** The manager and resident panels
  both mount `PortalFilterSortSheet`; `vendor-communication.tsx` does not. Pure
  parity gap, in the communication lane's territory.
* **Vendor Finances and Payments are still two nav entries.** The redesign
  merges them into one money section (Owed / Invoiced / Paid). Not started.
* **Vendor Calendar and Dashboard** are still on their own layouts. Calendar
  inherits the shared calendar's sticky date row and scroll fixes once it adopts
  the component. (Tasks is done — it took the list surface and floating dock.)

### Decisions still needed before those can finish

* **May a vendor decline a job?** They cannot today. The redesign's dock makes
  it one click, which is a capability change rather than a UI one.
* **Does a bid stay a form?** A bid is a money entry with an amount and a time,
  so it is left in the expanded row rather than becoming a dock action.
* **Do admin Settings need Staff and Platform groups?** Team access, audit log,
  service fee and feature flags were a guess — some may not exist, and some may
  not be wanted in staff hands.
