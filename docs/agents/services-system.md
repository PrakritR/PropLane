> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Services system (the one service lifecycle)

Owner of the **manager-side service system and the vocabulary every surface
shares**: the four stages, a vendor's answer, the manager actions, the service
record's rail and bands, Request bids / assign, and the bid cycle behind them.
Carved out of [`vendor-portal.md`](vendor-portal.md), which keeps the vendor
portal itself — the `vendor` role's plumbing, invites, onboarding, directory,
payouts, invoices and reviews.

The two models behind the Services nav, and the rule that they are never
merged, stay in AGENTS.md § There are no "work orders" in the product.

**Bidding lives in a table, not in `row_data`.** `work_order_bids`
(`supabase/migrations/20260704130000_work_order_bids.sql`) holds every vendor's
answer; `portal_work_order_records.row_data` only carries the lightweight
`biddingOpen` / `biddingOpenedAt` / `biddingResolvedAt` flags
(`DemoManagerWorkOrderRow` fields) plus the existing `vendorId` / `vendorName` /
`cost` fields that already model final vendor assignment.

## One vocabulary (services-vendors-1004)

Every service list - the manager Services page, a property's Services tab, a vendor record's
Services tab, the resident list, the vendor portal and the task list - uses ONE set of words, owned by
`src/lib/service-lifecycle.ts` (ids and legacy-id parsing in `src/lib/service-stage-ids.ts`). Import
from it; never re-declare a stage label or tab set.

- **Stages (the tabs):** Open - Assigned - Scheduled - Completed (`SERVICE_STAGE_TABS`). Open =
  nobody is doing it yet (new, or out for bids); Assigned = someone is, with no visit time; Scheduled
  = has a visit time; Completed = finished, and a vendor job then carries **To pay** or **Paid** as its
  fact (`completedPaymentFact`), never a fifth tab. A maintenance row is staged by
  `workOrderServiceStage`, an add-on by `addOnServiceStage`; the row fact (`workOrderStageFact`) and
  the record's stepper (`workOrderStageSteps`) come from the same functions, so a tab, its count, the
  fact and the stepper cannot disagree.
- **A vendor's answer** on one service: Requested - Estimate - Bid - Approved | Declined
  (`VENDOR_ANSWER_TABS`, `vendorAnswerGroup`, `vendorRequestFact`). An estimate is never approvable;
  only a Bids row has **Approve bid**; `compareBids()` lays submitted bids side by side.
- **Actions:** Request bids - Assign - Approve bid - Schedule - Complete - Pay
  (`MANAGER_SERVICE_ACTION_LABEL`); vendor side Give estimate - Book visit - Submit bid - Decline -
  Complete - Send invoice (`VENDOR_SERVICE_ACTION_LABEL`).
- **Old tab ids still resolve.** `done`, `pending`, `potential`, `active`, `current`, `upcoming`,
  `past` ... go through `parseServiceStage` (and `/services/work-orders/<id>` redirects, keeping any
  record path), and the old `vendor-schedule` section id is an alias of `vendors`
  (`SERVICE_DETAIL_TAB_ALIASES`). A saved link never falls home.
- **Retired words** (`tests/unit/service-vocabulary.test.ts` fails them in service / vendor / task UI
  copy): "Vendor & schedule", "Mark done", "Publish to vendors", "Compare quotes", "Potential",
  "Send quote", "Add quote". Pending / Active / Past / Done as a service state are retired too.
- **The service record** (`record-sections.ts` `service`): rail Service - Vendors | Linked: Incoming
  payments - Outgoing payments - Communication. Header icons in order: Message - Edit - Request bids or
  assign - Schedule - more (Cancel service and Delete, the only red items) - then ONE primary, the next
  step from the lifecycle (Request bids, Approve bid on one bid, Compare bids only with two or more,
  Schedule, Complete, Pay; `managerServiceNextStep`, which the Service tab's "Needs you" row reads
  too, so the header and the overview never name different next steps). "Request bids or assign" is one dialog (`ServiceAssignDialog`): Request
  bids (your vendors, up to 10, optionally PropLane vendors within a radius through the existing
  marketplace reach in `sendWorkOrderVendorOffers`) - A vendor - A teammate - Me.

## Estimate vs bid, and the service cycle (vendor-bids-1003)

**An estimate is not a bid.** The old note that a service goes to one vendor at a time is gone: a
manager requests up to 10 vendors at once (`work_order_vendor_offers`, `sendWorkOrderVendorOffers`),
and every requested vendor is one row that moves through

```
Requested -> Estimate and/or Estimate visit -> Bid -> Approved | Declined
```

- **Estimate** (`work_order_bids.estimate_cents`, `estimate_given_at`): the vendor's ONE rough
  number before seeing the job. It can never be approved and never becomes a payment.
- **Estimate visit** (`consultation_visit_at`, optional `estimate_visit_fee_cents`,
  `estimate_visit_done_at`): the vendor books a look. The fee (0 = free, capped at
  `MAX_ESTIMATE_VISIT_FEE_CENTS`) is shown on the manager's row; it is fixed once the visit is
  marked done.
- **Bid** (`amount_cents` + `materials_cents` + `proposed_time` + `bid_submitted_at`): the real price
  and time, and the ONLY thing a manager can approve. Allowed fresh, after an estimate, or after a
  visit. `bidCanBeApproved` (`src/lib/work-order-bid-approval.ts`) is the one predicate the server
  and the UI both read.

Vendor actions on `POST /api/portal/work-order-bids` (service-role writes, vendors stay SELECT-only
at the database): `give_estimate`, `book_estimate_visit` (alias `schedule_consultation`),
`complete_estimate_visit`, `submit_bid` (alias `submit`), `withdraw`. Manager actions:
`approve_bid` (alias `accept`) and `remove_request`. `approve_bid` re-derives that the service
belongs to the caller's workspace and that the bid belongs to the service, refuses anything without
a submitted bid (422), declines the other bids and tells their vendors, and books the bid's
`proposed_time` as the scheduled visit (either side can still move it). Every amount is read from the
stored row; a body amount is never used for a payout.

**One approved bid per service, and approving it twice is a retry.** A DIFFERENT bid on a service
that already has an `accepted` one answers 409; the partial unique index
`work_order_bids_one_accepted_idx` (`20261004020000_expense_payee_same_owner_and_one_accepted_bid.sql`)
is what holds that under a race. Two accepted rows would break every payout-anchor read, which
resolves the accepted bid with `.maybeSingle()` and would otherwise fall back to a body amount.
Re-approving the SAME bid is idempotent cleanup, not a second hire: the hire lands first and the
decline / offer-withdrawal / notification steps after it can fail transiently, so re-entering re-runs
only those, and re-stamps the assignment only when the service has no assignee at all.

**The estimate-visit fee is its own outgoing payment.** `complete_estimate_visit` (vendor marks the
visit happened; refused 422 before the visit time) files one vendor invoice per bid
(`invoice_number = VISIT-<bid id>`, unique index in
`20261003231000_work_order_bid_estimates.sql`, `ensureVisitFeeInvoice`) for the stored fee. It rides
the normal Approve & pay rail; `isGenuineVisitFeeInvoice` is what lets it be paid although that vendor
was never hired, and only when it matches a real bid whose visit happened at that fee. The job's own
invoice (`ensureSubmittedVendorInvoiceForMarkedDone`) ignores `VISIT-` invoices. The job payout is
built only when the service is completed AND assigned to a vendor
(`serviceIsVendorPayable`): yourself and teammates never create an outgoing row.

**Inside the service record** (rail and header icons: see One vocabulary above).
Overview and Photos are one Service tab (the resident's photos are a strip inside it); Payments is
Incoming payments. Old `/overview`, `/photos`,
`/payments` links redirect (`SERVICE_DETAIL_TAB_ALIASES`). The Service tab opens with the stage
stepper (Open · Assigned · Scheduled · Completed, + Paid for a vendor job; derived, never stored);
Vendors is one band (Requested · Estimates · Bids · Approved · Declined) with one row per requested
vendor (`deriveVendorRequestRows`), Approve bid only on a Bids row, a Compare toggle (only with two
or more bids) and a + reading **Add vendors**. The vendor answers on their own service page, in
`VendorEstimateBidSection` ("Estimate & bid", choices from `vendorReplyChoices`).

**Flow.** The manager requests vendors from the service's Vendors section (its + "Add vendors", or
"Request bids" in the Request bids or assign dialog), which sets `biddingOpen: true` on the work order (mirrored through the
local-first `updateManagerWorkOrder` -> `/api/portal-work-orders` "replace" sync) and sends each vendor
an offer through the SAME vendor resolution + email (Resend) + `deliverPortalInboxMessage` + audit-log
pipeline as the visit-scheduled email (`buildVendorBidOfferEmail` in `src/lib/vendor-visit-email.ts`).
A vendor may act only while they hold a `sent` offer or are the assigned vendor, and only while bidding
is open (or their own row is awaiting a bid after an estimate or visit) - a client-supplied work order
id never attaches a row to an unrelated manager's record. The manager reviews the rows on Vendors
and approves one; the approve action (server-side, service-role) sets that bid `accepted`,
every other `submitted` row on the service `declined`, patches the work order's `row_data` directly
(`vendorId`, `vendorName`, `cost`, `biddingOpen: false`, and the booked visit), bypassing the client
mirror (the manager's browser picks it up on its next `syncManagerWorkOrdersFromServer`), and notifies
the winner and, best-effort, each declined vendor.

**The service lists follow the lifecycle.** The manager Services page has Open - Assigned - Scheduled -
Completed (see One vocabulary), each tab and count from `workOrderServiceStage`; there is no Vendors
tab. A property record's Operations > Services tab is that same list (`ManagerAllServicesPanel` with
`lockedPropertyId`, in `PropertyServicesTab`), with the property's service catalog behind its settings
icon. A vendor record's Services tab uses the same four stages (`buildVendorServiceItems`; Open shows
that vendor's own answer as the fact), the same shared row with that vendor's own estimate or bid as the
figure; its + requests a bid on an open service or creates a service assigned to them.

**Every record section opens with one band** (`record-list-band.tsx`: `RecordTabBand` for a section,
`RecordListBand` for a list, both the Payments header). A band's round + always reads
**`Add <noun>`** — Add vendors, Add assignee, Add charge, Add payment — never the verb of the flow it
opens (`tests/unit/band-primary-labels.test.ts`). Service = Details · Photos · Activity + Edit;
Vendors = the vendor answers as tabs with counts (Requested · Estimates · Bids · Approved · Declined,
`vendorAnswerGroup`) + Filter, Compare on Bids and the round + (Add vendors); Incoming =
Pending · Overdue · Paid + Add charge; Outgoing = To pay · Paid + Add payment; Communication = the
counterparty tabs above the thread. Assign is the `ServiceAssignDialog` popup (add-ons never offer
vendors). Add charge / Add payment reuse the existing modals prefilled from the service; a charge is
stamped with the service id (`createManagerCharge({ workOrderId })`) so it lists under Incoming, and no
amount or ownership comes from the client. The stage is `deriveServiceStages` (maintenance) or
`deriveAddOnStages` (Open · Assigned · Scheduled · Completed); the Services list facts use the
same functions.

**An offered vendor is served a projected row, not a redacted screen.** A service a vendor only
holds an open OFFER on — including a stranger the local marketplace matched — leaves
`/api/portal-work-orders` through `projectWorkOrderForOfferedVendor`
(`src/lib/work-order-vendor-privacy.ts`): the street address, unit, entry notes and permission, the
resident's name and email, the resident's intake photos (unless the manager ticked "Share photos" on
the request), what the resident is billed, and any vendor price already recorded on the job are all
gone before the response is written, and `propertyName` becomes the general area
(`workOrderGeneralArea`). The last one matters on a service re-offered after its hired vendor went
silent: those fields still hold THAT vendor's approved figure, and the competitors now bidding have
no business reading it. The vendor panel's own `vendorCanSeeFullWorkOrderSite` redaction is
presentation on top of this projection, never instead of it.

**RLS** (`work_order_bids_vendor_read` / `work_order_bids_manager_read`):
BOTH sides are `FOR SELECT` only — vendor by `vendor_user_id = auth.uid()`,
manager by `manager_user_id = auth.uid()` (denormalized onto the bid row at
submit time so no join is needed). The original vendor `FOR ALL` owner policy
was replaced by `20260705120002_work_order_bids_vendor_select_only.sql`
because it let a vendor's own client INSERT bids on arbitrary work orders,
bypassing the service-role API's work-order-access + `biddingOpen` checks.
All real writes go through the service-role API exactly like every other
portal table in this codebase.
