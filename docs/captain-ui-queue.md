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
