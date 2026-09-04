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

## Open

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
