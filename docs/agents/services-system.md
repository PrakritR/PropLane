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

## The property Services page is services offered, by stay (property-term-split-1005)

A property record's Services section lists the services **offered** there (`serviceRequestOptions`), under
**Long term · Short term** tabs. Each service carries `appliesTo?: "long_term" | "short_term" | "both"`
(`ManagerListingServiceOption`); **absent = both**, so a service for both stays shows in both tabs and
existing rows land in both. The tab rule is the one helper `src/lib/property-stay-tabs.ts` (a stay the
property does not allow has no tab unless a service for that stay alone still exists, so nothing is
hidden). Quick add presets and their stay defaults live in `src/lib/property-services-by-stay.ts`.
**Service requests (Open / Assigned / Scheduled / Completed) are not listed on the property page** — they
live on the main Services page, which already filters by property.

**AI info has the same split.** Every AI info row is shared by default; a built-in row may carry a
short-term version in `aiCommunicationInfoShortTerm` (listing submission JSON, no schema change) and a
custom row an `appliesTo` (absent = both). The assistant reads them through
`src/lib/property-ai-info-by-stay.ts`: a short-term prospect gets the short-term text when present else
the shared text; a long-term prospect gets the shared text only (short-term text is never mixed in); an
unknown stay gets both, labelled. `get_listing_details` takes an optional `stay` for this.

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
  "Send quote", "Add quote". Pending / Active / Past / Done as a service state are retired too. One
  deliberate exception: the add-on header's finishing step reads "Mark done" (the approved studio plan),
  defined once in `src/lib/service-header-next-step.ts` and allow-listed there; maintenance keeps "Complete".
- **The service record** (`record-sections.ts` `service`): rail Service - Vendors | Linked: Incoming
  payments - Outgoing payments - Communication, the same for an add-on and a maintenance service. ONE
  header for both kinds: Message - Edit - more (⋯) - then the next step as the ONE labeled primary button
  (`portalLabeledPrimarySpec`; every other header control is an icon). The ⋯ holds the red items: Decline
  request + Delete on an add-on, Cancel service + Delete on maintenance (and, not red, Reschedule /
  Auto-schedule / Leave a review where they apply). An add-on's primary follows its status
  (`addOnHeaderNextStep`): pending -> Approve, approved -> Mark done, nothing once returned or declined; a
  maintenance service's is `managerServiceNextStep` (Request bids, Approve bid on one bid, Compare bids only
  with two or more, Schedule, Complete, Pay); the Service page has no "Needs you" row of its own, so the
  header's labeled primary is the one place the next step is named. Request bids / Approve bid / Compare bids open
  Vendors on the right tab. Edit opens `ServiceEditPopup` (the New property shell: Service - Home - Price -
  Schedule) for both kinds; the inline price pencil is gone. The Service page's one assignment card is
  "Who's doing it" (`ServiceWhoCard`): nobody yet -> "Assign someone on your team" (`ServiceAssignDialog`,
  team only, titled Assign) or "Send to vendors" (Vendors > Available); someone on it -> ONE row like a Vendors
  row (tile, name, trade, visit, "$140 approved") with Reschedule beside its ⋯ (Open vendor, Message; Change
  for a teammate).

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
was never hired, and only when it matches a real bid whose visit happened at that fee.

**Which invoice is a visit fee is a SERVER decision, never the invoice number.** The marker is
`vendor_invoices.estimate_visit_bid_id` (`20261004150000_vendor_invoice_estimate_visit_marker.sql`),
written only by `ensureVisitFeeInvoice`. `invoice_number` arrives verbatim in the vendor's own
submission body, so a `VISIT-` prefix there is vendor-controlled input: reading it let the assigned
vendor number their own job bill that way and walk past both the double-pay guard and the job-expense
guard. Everything that has to tell the two apart reads the column —
`isGenuineVisitFeeInvoice`, the job's own invoice (`ensureSubmittedVendorInvoiceForMarkedDone`,
which ignores marked rows), `findBlockingVendorPayout`, and the posted-expense read. A visit fee
closes NEITHER expense line of the job (`linesClosedByPostedRow`): a paid $50 visit is not the
accepted bid's labor, and treating it as the whole bill suppressed the job's own expense. A read
that cannot tell them apart refuses rather than posting.

Two vendor invoices therefore exist against one service, so a payout is unique per
**(work order, invoice)**, not per work order — see
[`vendor-portal.md`](vendor-portal.md) § The payout timeline.

The job payout is built only when the service is completed AND assigned to a vendor
(`serviceIsVendorPayable`): yourself and teammates never create an outgoing row.

**Mark done books the accepted bid's cost, not the client's.** `POST /api/portal/work-orders/complete`
reads the `accepted` bid itself (`amount_cents` / `materials_cents` / `vendor_directory_id`) exactly as
approve-and-pay does, and a body figure stands in only when no bid was accepted (a directly-assigned
job). More than one accepted bid answers 409 rather than guessing which one is the payout anchor. A
completion carrying no cost at all posts nothing and reads nothing — marking a job done is not a money
move.

**Inside the service record** (rail and header icons: see One vocabulary above).
The Service tab is ONE page (`ServiceDetailsSection`, no Details / Photos / Activity sub-tabs and no stat
tiles), top to bottom: the stage stepper (Open · Assigned · Scheduled · Completed, + Paid for a vendor job;
derived, never stored), Who's doing it, the Request card (details, preferred arrival, entry, priority) and
Home card, Photos (a count and the add-photo icon in its header, a grid or "None yet") and Activity (the
timeline). Payments is Incoming payments. Old `/overview`, `/photos`, `/payments` links redirect
(`SERVICE_DETAIL_TAB_ALIASES`).

**The approved bid is the hire, whatever the row says.** The server's `approve_bid` writes the vendor, price
and booked visit onto the row, and the manager's browser mirror can lag it (an approval written the older way,
or from another tab). The service page therefore ALWAYS loads that job's bids, and `applyAcceptedBid`
(`manager-service-workflow.ts`) fills in what the row is missing from the accepted bid (vendor, visit =
`proposed_time`, amount, Scheduled). `deriveServiceStages`, `workOrderServiceStage`, `workOrderStageFact` and
`workOrderStageSteps` apply it themselves, so the stepper, the header's next step, Who's doing it and Vendors >
Scheduled cannot disagree. A row held by a teammate is left alone.

Vendors is one pipeline (`ServiceVendorPipeline`, bucketed by `buildServicePipeline` in
`src/lib/service-pipeline.ts`): **Available - Sent - Bids - Scheduled - Done** with counts. Available =
your roster vendors that match the job's trade and have not been offered it (every roster vendor when none
match). Sent = open offers, estimates and vendors who declined. Bids = submitted bids only, with a Compare
toggle with two or more. Scheduled = the approved vendor, visit time and amount. Done = amount and To pay /
Paid. Every row is the Vendors list's row (`PortalApplicantRecordRow`: tile, name, trade, glyph facts such as
rating, state facts like the bid or the visit, ⋯) - never a badge, a checkbox, an inline button or a bar. Each
row's ⋯ (`RowActionsMenu`): Available -> Send job, Open vendor; Sent -> Withdraw, Open vendor; Bids -> Approve bid
(a submitted bid only), Open vendor; Scheduled -> Reschedule, Mark done, Open vendor; Done -> Pay (while owed),
Open vendor. The band has the round + (labelled "Add bid request", per the band rule) that opens the standard
**Send job** popup (`ServiceSendJobPopup`, the New property shell): a Vendors dropdown (multi-select of the
Available vendors, max 10), the "Also send to PropLane vendors within" switch with a 5 / 10 / 25 mi dropdown, and
Send. For an add-on the host's `onSend` creates the linked vendor job exactly as before. What a vendor can see
before approval is enforced server-side; no sentence about it is drawn. No checkbox in a record
(`record-page.md` rule 5, `tests/unit/record-page-no-footer.test.ts`). The Requested / Estimates / Bids / Approved / Declined tab set and `AddOnCycleSection` are retired
(an estimate stays visible as a fact on the vendor's Sent or Bids row; it is still never approvable). The vendor answers on their own service page, in
`VendorEstimateBidSection` ("Estimate & bid", choices from `vendorReplyChoices`).

**Flow.** The manager sends the job from the service's Vendors section (the round +, or a row's Send job), which sets `biddingOpen: true` on the work order (mirrored through the
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
**`Add <noun>`** — Add charge, Add payment — never the verb of the flow it
opens (`tests/unit/band-primary-labels.test.ts`). Service = one page, no band (see above);
Vendors = the pipeline above (Available · Sent · Bids · Scheduled · Done, `PIPELINE_TABS`) + Filter and
Compare on Bids + the round + that opens Send job; Incoming =
Pending · Overdue · Paid + Add charge; Outgoing = To pay · Paid + Add payment; Communication = the
counterparty tabs above the thread. Assign is the `ServiceAssignDialog` popup, team side only (a teammate or you); vendors are sent the job from
Vendors > Available. Add charge / Add payment reuse the existing modals prefilled from the service; a charge is
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

**The general area is never a street address.** A property NAMED after its address ("123 Main St,
Seattle, WA") used to publish that name as the area, because the old rule simply took the text before
the first comma. `workOrderGeneralArea` now drops any part that reads as a street line, keeps the
city, and answers "Nearby" when nothing left is safe to show.

**The offer notification carries the same projection.** `sendWorkOrderVendorOffers` emits the
vendors' copy with the general area and no unit, and the manager's own copy as a SEPARATE event that
says the house's real name — one emit naming the site to both audiences is how an address reached an
offered vendor by email. The emits are deduped on their own event ids, so a retry notifies nobody
twice.

**RLS** (`work_order_bids_vendor_read` / `work_order_bids_manager_read`):
BOTH sides are `FOR SELECT` only — vendor by `vendor_user_id = auth.uid()`,
manager by `manager_user_id = auth.uid()` (denormalized onto the bid row at
submit time so no join is needed). The original vendor `FOR ALL` owner policy
was replaced by `20260705120002_work_order_bids_vendor_select_only.sql`
because it let a vendor's own client INSERT bids on arbitrary work orders,
bypassing the service-role API's work-order-access + `biddingOpen` checks.
All real writes go through the service-role API exactly like every other
portal table in this codebase.

## An add-on on a vendor: the linked vendor job (mobile-step-tabs-1004, D7)

Add-ons live in `portal_service_request_records` and have no bidding tables, so a vendor reaches one through a
LINKED work order (`src/lib/add-on-vendor-job.ts`, `add-on-vendor-job-actions.ts`). The first "Send job"
creates it (`ensureAddOnVendorJob`, id `<add-on id>-vendor-job`, deterministic so a retry never makes a
second): `row_data.linkedServiceRequestId` on the work order, `linkedWorkOrderId` on the add-on. Then it is
the ordinary offer path (`sendWorkOrderToVendors`), and the add-on's Vendors section reads that job's
offers and bids (`useAddOnVendorJob`); approve, schedule, Mark done and Pay use the same routes a
maintenance service uses.

- **The resident's charge stays on the add-on ONLY.** The job has no resident, no email, no
  `residentChargeCents`; every client charge generator checks `workOrderMayBillResident` first, and the work
  order route never announces the job as a new service (`emitCreatedWorkOrder`).
- **The two models stay separate.** `withoutLinkedVendorJobs` keeps the job out of every Services list and
  count; the add-on's stage reads the job once a vendor is hired (`applyVendorJobToAddOn`: the vendor is the
  assignee, the job's visit the visit, a finished job completes an approved add-on).
- **Privacy is unchanged.** An offered vendor is served the projected row (`projectWorkOrderForOfferedVendor`:
  general area only, no resident, and no `linkedServiceRequestId`).
- **The link is manager-owned.** `POST /api/portal-work-orders` strips `linkedServiceRequestId` and
  `linkedWorkOrderId` from a RESIDENT's write and restores only what the server already stored: a
  resident who could set it would hide their own service from every manager list and count
  (`withoutLinkedVendorJobs`) and skip the manager's new-service notice.
- **The job describes only what the manager published.** `buildAddOnVendorJobRow` takes the add-on's
  `offerDescription` (else its title) and never the resident's own `notes` — free text a merely
  offered vendor has no business reading. A job saved before that rule may still hold those notes, so
  the offered-vendor projection replaces an add-on job's `description` with its title.
- `assignableKindsFor("vendor")` now includes `service`, but an add-on's own assignee picker stays team-only; a
  vendor is on an add-on only by being sent the job.

## Communication is per party and about this service (D9)

A service's Communication section (`ServiceCommunicationPane`) has one tab per party - the resident first, then
every vendor the job went to (`serviceCommunicationParties`). Each tab shows ONLY the threads whose
`recordRef` is this service (`serviceThreadsForParty`; for an add-on also its linked job's id) and that party
- no counterparty-email / phone matching on the service page (it stays on every other record page). The
footer links to the full conversation on the Communication page. Offer, bid and visit notifications are
stamped with `{kind: "service", id}` (`serviceRecordRefForEvent`, `action-events.server.ts`,
`vendor-notification-delivery.ts`, `notifyWorkOrderEvent`). A thread keeps the FIRST ref it is stamped with, so
one party's single conversation is attributed to whichever service spoke to them first.
