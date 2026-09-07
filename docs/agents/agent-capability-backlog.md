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

## Done: resident maintenance depth (PRP-269)

`report_maintenance_issue` (`src/lib/tools/domains/resident/maintenance.ts`) now
reaches parity with the Services form: title, priority (incl. Emergency),
category, preferred arrival window (presets + custom), entry permission and
entry notes are all on the schema, and each renders on the confirm card.
Everything stays optional, so "the heater is dead" still files in one line and
`createWorkOrderFromResidentSms` keeps inferring the rest.

**Photos took the shape this note predicted, and the rule it set still holds:
no image bytes in a tool schema.** The resident chat route stashes each parsed
attachment privately under the resident's own storage prefix and puts
`{ index, storagePath }` on `ctx.chatPhotos` for that ONE request; the model
references a photo by its position (`attachmentIndexes`), never by content. The
preview resolves those indexes to storage paths and pins them in
`confirmedInput`, because the confirm request is a different request and the
stash is gone by then. `ownedResidentChatPhotoRef` re-checks at both preview and
execute that a path is under the caller's own prefix, is an inbox-attachment
path, carries no traversal or key-reshaping characters and ends in an image
extension — a reference from anywhere else is refused, never downloaded.
Coverage: `tests/unit/tools/resident-portal.test.ts`.

## Resident work-order lifecycle

Closed for maintenance requests (PRP-268): `update_work_order`,
`cancel_work_order`, and `nudge_manager_on_work_order` in
`src/lib/tools/domains/resident/work-order-lifecycle.ts` mirror the panel's
Edit / Cancel / Send reminder on the resident's own OPEN request, through the
shared `resident-work-order-lifecycle.server.ts` and the same reminder path
`/api/portal/work-orders/send-reminder` runs. Still open, on the ADD-ON
service-request side of the Services section:

- Delete a service request (`resident-services-panel.tsx` `:269`)
- Nudge the manager on a service request (`:864`,
  `/api/portal/service-requests/send-reminder`)
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
