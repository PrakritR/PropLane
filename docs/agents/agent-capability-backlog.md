# Agent capability backlog

What the assistant still cannot do that the UI can, audited September 2026 while
the manager SMS agent and the tour tools were built. Each row names the UI call
site it has to reach parity with, so the next pass starts from evidence rather
than a re-audit.

Read [`docs/ai-assistant.md`](../ai-assistant.md) first — the tool-layer
contract and the add-a-tool checklist apply to everything here. A gap is closed
by ADDING A TOOL, never by working around the layer.

Two things are deliberately absent and are not gaps: lease signing (a legal
ceremony — deep-link to `/resident/lease`) and completing a payment (the agent
hands over a Stripe Checkout link and stops).

## Next up: resident maintenance depth

`report_maintenance_issue` (`src/lib/tools/domains/resident/maintenance.ts`)
files a REAL work order into `portal_work_order_records` — it is not a message —
but its input schema is `description` only, so category, title and priority are
inferred by `createWorkOrderFromResidentSms`. The UI
(`resident-add-service-modal.tsx:135-217`) collects far more, and every field
below is one the manager and the dispatched vendor actually act on:

| Field | Where the UI collects it |
| --- | --- |
| title | `resident-add-service-modal.tsx` repair branch |
| priority, including Emergency | same |
| category | same |
| preferred arrival window | same |
| entry permission + entry notes | same |
| up to 6 photos (`photoDataUrls`) | photo picker, `:89-133` |

Everything except photos is a schema widening plus a pass-through.

**Photos are the one genuinely hard item.** A model cannot put binary in a tool
call, and the read tools deliberately strip photo blobs
(`resident/services.ts:16`). The portal chat already parses images
(`src/lib/agent/images.ts`, `MAX_CHAT_IMAGES`), so the shape that works is: the
chat route stashes the parsed attachments for the turn and the tool references
them by index, with the tool re-reading them server-side. That is a real design,
not a widening — do not bolt a `photoDataUrls` string array onto the schema.

## Resident work-order lifecycle

The resident can do all of this in `resident-services-panel.tsx`; the agent
cannot do any of it.

- Edit an existing work order — title, priority, preferred arrival, entry
  permission, entry notes, details (`:808`)
- Cancel / delete a work order (`:828`); delete a service request (`:269`)
- Nudge the manager on a work order (`:835`, `/api/portal/work-orders/send-reminder`)
  or a service request (`:864`, `/api/portal/service-requests/send-reminder`)
- Custom add-on price limit on `create_service_request` (`:239-276`)

## Resident, everything else

Ordered roughly by how often it comes up.

- **Profile + notification preferences.** Nothing corresponds to
  `PATCH /api/profile` or the text-notification settings
  (`resident-profile-panel.tsx:159`, `:379`).
- **Message attachments and SMS channel choice** on `send_message_to_manager`.
  The resident inbox has both (`resident-inbox-panel.tsx:69-74`, `:928`); the
  manager side just gained the channel choice (`send_message`'s `deliverViaSms`),
  so the resident tool is now the asymmetric one.
- **Documents:** upload own documents, upload a signed lease PDF, download a
  rent receipt or ledger (`resident-other-documents.tsx:313`,
  `resident-documents-panel.tsx:482`).
- **Applications:** submit, withdraw (`resident-applications-panel.tsx:766`),
  invite a cosigner.
- **Full lease renewal** — new term, start date and rent
  (`lease-amend-move-out-modal.tsx:516`). `request_lease_extension` only amends
  the end date.
- **Delete an inbox thread**; add/set-default payment method; submit
  bug/feedback.

## Tours, remaining

The tour tools shipped are `list_open_tour_slots`, `request_tour` (resident +
leasing SMS), `book_tour`, `reschedule_tour`, `cancel_tour`. Still missing:

- **`decline_tour_inquiry`.** Blocked on an extraction: the decline logic —
  ownership check, guest notification, flipping the inquiry to `declined`, and
  deleting the per-window rows — is inline in
  `src/app/api/portal-tour-inquiries/delete/route.ts:70-218`. It needs the same
  treatment `createTourInquiry` and `listOpenTourSlots` got before a tool can
  wrap it.
- **Tour settings and reminders.** `/api/portal/manager-tour-settings` (notice
  days, default grid hours) and `/api/portal/tour-reminders` are UI-only.
- **Reading the tour proposal queue as such.** `TourProposalsPanel` and
  `/api/portal-tour-inquiries/proposals` have no tool; the agent sees those
  proposals only through the generic pending-action gate.

## Removed: the F-PAY-1 evidence harness

`tests/unit/evidence-manager-money-agreement.test.tsx` was deleted in September
2026. It rendered `ManagerDashboard` + `ManagerPayments` against one seeded
portfolio to screenshot them, and it had **never once completed**: the render
never settled, so the file allocated until its vitest worker died with
`FATAL ERROR: Ineffective mark-compacts near heap limit`. Vitest still exited 0
and reported `928 passed (929)`, so a permanently `pending` test looked like a
green suite for months.

Nothing was lost. The assertions it claimed to make live in
`tests/unit/manager-payments-dashboard-agreement.test.ts` (12 tests over every
F-PAY-1 rule, including "the dashboard's unpaid count equals the Payments
Pending + Overdue tabs"), and `tests/unit/manager-dashboard-banners.test.tsx`
renders `ManagerDashboard` in ~1.7s — so there is **no render loop in the
component itself**; the fault was this file's mock setup. Stubbing the one
unstubbed background sync (`syncScheduleRecordsFromServer`) did not fix it, and
the cause was not pursued further.

If the rendered-evidence idea is wanted again, start from
`tests/unit/manager-dashboard-banners.test.tsx`'s mock set, which is known to
settle, rather than reviving the deleted file.

## Known ceilings accepted on purpose

Not bugs. Reopen only with the reasoning, not just the wish.

- **Destructive manager tools are unavailable over SMS.**
  `buildManagerSmsRegistry` (`src/lib/tools/index.ts`) withholds every
  `destructive` write, because the only credential on that surface is the Twilio
  `From` header, which is attacker-influencable, and the confirmation is a
  one-word YES with no card to re-read. Upgrade path if a manager needs one: a
  per-manager opt-in plus a stronger confirmation token, or bouncing the ask to
  the portal. Do not simply widen the filter.
- **`loadManagerTourBlocks` still omits Google-busy.** It backs the
  approval-first proposal flow (`tour-proposal.server.ts`) and only mirrors the
  public grid's exclusion set by hand. `listOpenTourSlots` is now the complete
  answer; folding the proposal flow onto it would remove the last place two
  definitions of "open" can drift.
- **Approving a rental application and creating/editing a listing have no
  tool**, and should not get one until `recordApprovedApplicationCharges` and
  listing normalization move server-side. See AGENTS.md.
