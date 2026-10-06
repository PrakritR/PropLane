> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Vendor portal (Phase 1 foundation)

A 4th portal role — `vendor` — sits alongside manager/resident/admin. Phase 1
covers vendor login + portal shell + work-order visibility + notifications.
Phase 3 (Stripe Connect payouts) and Phase 5 (reviews) are documented below; the
service lifecycle a vendor bids into is
[`services-system.md`](services-system.md).

**Role plumbing.** `"vendor"` was added to `AuthRole`
(`src/lib/auth/portal-roles.ts`) and `PortalKind` (`src/lib/portal-types.ts`) —
two parallel enums, both needed. Every hardcoded role-literal guard across the
auth flow (`portal-access.ts`, `set-active-portal`, `resolve-oauth-portal-access.ts`,
`post-oauth-routing.ts`, `migrate-portal-user-id.ts`, `profile-role-row.ts`) was
extended in lockstep — when adding a 5th role, grep for `"resident" ===` /
`"manager" ===` literal chains rather than assuming one canonical `isAuthRole`.

**Portal registry.** `src/lib/portals/vendor.ts` is the section list — read it
rather than a copy here. Two naming notes that outlive any list: Services keeps
the section key `work-orders` (relabeled from "Work Orders" in the mobile-nav-m1
overhaul), and Tasks is `tasks`, the vendor's view of manager tasks assigned
to them (`VendorTaskList`, `GET/PATCH /api/vendor/tasks`, tabs
`in-progress`/`completed`; bare `/vendor/tasks` is the default in-progress view —
legacy `/vendor/task-list/...` redirects there).
Routes live at `src/app/vendor/layout.tsx` +
`src/app/vendor/[section]/[[...tab]]/page.tsx`, copied from the resident
portal shell. Render handlers are in `render-portal-section.tsx` under
`kind === "vendor"` blocks (after the resident blocks, before the generic
tabbed-workspace fallback). The native bottom bar's primary set is
`NATIVE_BOTTOM_NAV_VENDOR_PRIMARY` and its full order is
`NATIVE_BOTTOM_NAV_VENDOR_ORDER` (`src/lib/native/portal-bottom-nav.ts`), which
must stay in sync with the registry — Dashboard and Settings are reached via the
shared `PortalMobileNavBar` (back arrow + top-right profile menu), which every
portal's mobile/native layout renders now.

**Invite → signup linking.** A manager's "Send invite" (Vendors — reachable at
`/portal/vendors` (`vendorListHref` in `portal-detail-routes.ts`; `?tab=catalog`
for the PropLane vendors tab), the `ManagerVendorsPanel` component under the
Operations section's Vendors item; no longer a Services sub-tab — that was
removed as redundant with the Services sub-tab. **`/portal/relationships/vendors`
is a STALE URL** — this doc said so until night/vendor-signup's proof-bug fix
pass hit it directly: `render-portal-section.tsx`'s Teams-retirement redirect
(PLAN-0923-1934) sends `section === "relationships"` unconditionally to
`/portal/profile?tab=workspaces`, so that old path never reaches the vendors
panel at all, even though the page still 200s on first load. Always use
`vendorListHref`/`/portal/vendors`, never hand-type the old path.)
writes a `vendor_invites` row (`manager_user_id`, `vendor_directory_id`,
`vendor_email`, status) — the invitee has no account yet, so this can't use the
`account_link_invites` Axis-ID-lookup shape; it's matched by lowercased email at
signup instead, mirroring how `manager_application_records` links residents.
`provision-vendor-account.ts` does the linking: on signup it looks up the
pending invite by email, links (or creates) the `manager_vendor_records` row,
sets its `vendor_user_id`, and marks the invite accepted. A vendor CAN also
self-serve signup from the public marketing CTA with no invite at all — they
just land with no linked manager until one exists.

**PropLane catalog vendors are not a blank invite.** Adding one from the
catalog is property-scope only (which houses they can work) — contact, trade,
and rates stay on the catalog card. Overview and Profile are one Overview tab.
Catalog Communication is the record thread (`RecordCommunicationSection`) with
Send via PropLane / Email / SMS; the first send adds them to Your vendors
(Every property) if they are not already there. Regular Add vendor keeps the
six-step workspace.

**Invites are server-issued and always expire.** `vendor_invites` is
`SELECT`-only for `anon`/`authenticated` (owner-scoped read;
`20260722123000_lock_role_grant_surface.sql`) — only the service-role issuing
route writes one. Redemption turns an invite into a **pre-confirmed** account on
its `vendor_email`, so both lookup paths in `provision-vendor-account.ts` (by
token and by email) go through `redeemableInvite`, which fails closed on a
missing/unparseable/elapsed `expires_at`. `expires_at` is `NOT NULL` and
defaults to `now() + 7 days`, matching the `VENDOR_INVITE_TTL_MS` the issuing
route stamps. Never reintroduce an expiry-optional path — a NULL expiry
previously skipped the TTL check entirely. Coverage:
`tests/unit/vendor-invite-redemption-ttl.test.ts`.

**Unlinked-signup notice — now STATE-driven (night/vendor-signup).** The
Dashboard banner no longer depends on a notice having been queued during this
particular signup: `vendor-dashboard.tsx` fetches `/api/vendor/profile` on
every load and shows the banner whenever `linked === false`, regardless of
entry path (password, Google/Apple, invite, or the email-confirmation link
that previously left `registerSelfServe`'s `confirmed === false` branch
queuing nothing). `pending-notice.ts` — the sessionStorage queue, its TTL and
destination guard — is now supplementary only: when a specific reason
(`"invite_expired"` | `"invite_revoked"`) was queued, it supplies that reason's
copy; otherwise the banner falls back to a generic "waiting on a manager"
message. A destructive read or a reload no longer loses the banner, because
state, not delivery, is what renders it.

**Self-serve onboarding (night/vendor-signup).** A vendor who signs up with no
invite now lands at `/vendor/onboarding` (every signup path's default
`redirectTo`/`nextPath` changed from `/vendor/dashboard`) — Business name,
Trades (`VENDOR_TRADE_OPTIONS`), service area (city + ZIPs + radius), optional
license number/document, optional insurance provider/policy/expiry/certificate,
and a directory-listing toggle. These live on `vendor_business_profiles`
(additive columns: `trades`, `service_area_zips`, `service_radius_miles`,
`license_number`, `license_doc_path`, `insurance_*`, `directory_listed`,
`onboarding_completed_at`) — the vendor's OWN record, so none of it requires a
manager link, unlike `/api/vendor/profile` and `/api/vendor/documents/*`
(both still gated on `resolveOwnVendorRecords` returning a row). License/
insurance uploads go through `/api/vendor/onboarding/documents` (upload) and
`/api/vendor/onboarding/documents/signed-url` (read), same private
`vendor-documents` bucket and path convention as the existing manager-linked
uploads, but keyed off `vendor_business_profiles` instead of
`manager_vendor_records.row_data.vendorDocuments`.
`onboarding_completed_at` is server-derived (`vendorOnboardingRequiredFieldsFilled`
in `vendor-business-profile.server.ts`) from business name + at least one trade
+ a service area, and — once set — never un-sets, even if a field is later
cleared. The vendor Dashboard shows a "Finish setting up" checklist (Business,
Trades & area, License & insurance, Payout bank — the last linking to the
existing `/vendor/financials/payouts` Connect flow) until all four are done.

**Manager-facing vendor directory (night/vendor-signup).** A directory-listed,
onboarding-complete self-serve vendor (`directory_listed = true`) is now
discoverable in the manager "PropLane vendors" tab
(`pro-vendors-panel.tsx`), merged alongside the curated `AXIS_VENDOR_CATALOG`
and shared-roster rows via `GET /api/manager/vendor-directory`
(`src/lib/vendor-directory.server.ts`'s `loadDirectoryListedVendors`), public-safe
fields only — business name, trades, area, and derived `insured`/`licensed`
flags (a current, non-expired certificate; never the policy number or a doc
path). Filterable by trade/area through a Filter toggle on that tab. Row
"Add to your vendors" for a directory row calls `POST
/api/manager/vendor-directory/add` rather than the generic
`ensureCatalogVendorOnRoster` path (which never touches `vendor_user_id`):
it sets the manager_vendor_records `vendor_user_id` DB column directly, the
same real link invite redemption creates, so the vendor's unlinked banner
clears immediately. Idempotent per manager+vendor pair (`catalogId:
"self-serve-<vendorUserId>"` lets the existing `findRosterCatalogMatch` detect
an already-added row). Known gap: the catalog detail page's header "Add"
action and its communication-tab auto-ensure both still route a directory
row's initial add through this linked path (patched), but a future third add
entry point must do the same or it will silently fall back to the
non-linking `ensureCatalogVendorOnRoster`.

**Directory privacy.** Linked vendors cannot directly SELECT `manager_vendor_records`; `20260912230000_vendor_directory_private_fields.sql` removes that policy. Vendor portal readers use authorized service-role routes, and catalog responses use `vendorCatalogProjection`.

**Row-level isolation (original foundation).** `manager_vendor_records`,
`portal_work_order_records`, and `vendor_tax_profiles` all gained a nullable
`vendor_user_id` column populated once the vendor signs up. Work orders and tax
profiles retain vendor-scoped SELECT policies; the directory policy was removed
as described above because its rows contain manager-private fields.
`/api/portal-work-orders` resolves `vendorId` (a
`manager_vendor_records.id` string) → `vendor_user_id` via
`resolveVendorUserId()` scoped to the work order's owning manager (never
trusting a client-supplied directory id from another landlord) at write time so
vendor GET requests can scope directly
by `.eq("vendor_user_id", user.id)`; vendor writes to that route are rejected
(vendor is read-only — the manager owns assignment/scheduling).

**Notifications.** Work-order-offer notification (Axis inbox message + email)
is NOT a separate new endpoint — it's wired into the EXISTING
`/api/portal/send-vendor-visit-email` route, which the manager UI already calls
whenever a visit is scheduled/rescheduled (`manager-work-orders-panel.tsx`).
That route now also calls `deliverPortalInboxMessage()` with
`toUserIds: [vendorUserId]` (resolved from the vendor's directory row) whenever
the vendor has signed up; the email always sends via the vendor's stored email
regardless of signup status. Phase 2 (tour → bid) should hook the same
`deliverPortalInboxMessage` call rather than growing a second notification path.
The vendor's own `/vendor/reviews` has a rating filter ("5 stars", "4 stars &
up", …) — a workspace filter was also requested (C263) but is intentionally
NOT built: `mapPublicVendorReviewRow`'s `reviewerLabel` is hardcoded to "A
PropLane manager" for every review on that route specifically so a vendor can
never learn which manager/workspace reviewed them, and a workspace filter
would require exposing that identity.

Inbox scoping added a 3rd scope constant (`axis_portal_inbox_vendor_v1`,
mirrored across `portal-inbox-delivery.ts`, `portal-inbox-thread-scope.ts`, and
the legacy duplicate in `send-inbox-message/route.ts` — yes, the scope-for-role
logic is duplicated 3x pre-existing, not something introduced here). Manager →
vendor and vendor → manager messaging permission checks were added to
`src/lib/inbox-recipient-scope.ts` (`linkedVendorsForManagers`,
`managerIdsOwningVendor` / `isVendorRole` branches) — without these the
automatic notification would silently get filtered out by
`filterRecipientsBySenderScope`.

**Vendor self-service tax profile.** The manager-facing
`/api/vendors/[id]/tax-profile` route requires manager auth
(`assertManagerFinancialsAccess`) and can't be reused by the vendor directly.
A separate `/api/vendor/tax-profile` route lets the signed-in vendor read/write
their OWN `vendor_tax_profiles` row, resolving `(manager_user_id, vendor_id)`
server-side from their own `manager_vendor_records.vendor_user_id` link — never
trusting client input for those two key fields.

# Vendor portal (Phase 2: what a vendor sees of a service)

The service lifecycle itself — the four stages, a vendor's answer (Requested ·
Estimate · Bid · Approved | Declined), the manager actions, Request bids /
assign, the `work_order_bids` table and its RLS, and what an offered vendor is
allowed to read — is owned by
[`services-system.md`](services-system.md). Read it before changing anything a
vendor does on a service — including the vendor's own `VendorEstimateBidSection`
and the four Services tabs it answers under. Only the vendor-portal side lives
below.

**Jobs board retired (C152/C153 superseded).** A standalone `/vendor/jobs`
section with Invited/Open tabs and a cross-workspace open-marketplace browse
(`work_order_open_listings`, `openListingId` on `work_order_bids`,
`resolveVendorWorkOrderAccess`'s `"open_listing"` access kind) previously
existed alongside Services. The captain cut it (2026-09-26): a vendor never
browses another workspace's jobs, and there is no Jobs nav item — every service
a vendor was asked to bid on, including one a manager published to nearby
PropLane vendors (opt-in, see `services-system.md` § One vocabulary for that
dialog), is an offer row on
Services' own **Open** tab (`vendorWorkOrderTab`), the same rows Services
already showed. `/vendor/jobs*` redirects to
Services (`render-portal-section.tsx`). `resolveVendorWorkOrderAccess` is back
to a plain `"assigned" | "offered"` access kind; the `work_order_open_listings`
table and its migration are untouched in the database (no drop migration) but
no code path reads or writes it any more. Bid submission stays rate-limited
per vendor (`work-order-bid-submit:<vendorUserId>`, 20/hour) as a general
anti-spam guard.

# Vendor portal (Phase 3: Stripe Connect payouts + invoices)

**Connect account reuses the manager's column.** `profiles.stripe_connect_account_id`
(added for managers in `20250421120000_profiles_stripe_connect_account.sql`) is generic —
keyed by `userId` only — so it's reused as-is for a vendor's own Connect Express account
rather than adding a new column; a vendor and a manager are always different auth users, so
there's no collision risk. `ensureVendorConnectAccountId` (`src/lib/stripe-connect-account.ts`)
is a thin wrapper over the existing `ensureManagerConnectAccountId`, passing
`axisPortal: "vendor"` so the Stripe account's `metadata.axis_portal` distinguishes vendor
from manager accounts in the Stripe Dashboard.

**Vendor-specific onboarding routes.** `/api/vendor/stripe-connect/{onboard,status,account-session}`
are clones of the manager `/api/stripe/connect/*` routes (not a generalized single route):
the manager routes resolve a payout OWNER (a co-manager may act on the owner's account),
the vendor routes act only on the signed-in vendor's own account and gate on the vendor
role. Onboarding is embedded (Stripe's `account_onboarding` / `account_management`
components from `account-session`) — there is no Account Link redirect and no Express
Dashboard login link; the vendor's balance, Withdraw and schedule live on the Payouts tab of
Finances (`/vendor/financials/payouts`, `PortalPayoutsPanel portal="vendor"`, routes under
`/api/vendor/payouts/`). Owner of the payout model: `financials.md` § In-app payouts. The
shared `PortalStripeConnectPanel` component
(`src/components/portal/portal-stripe-connect-panel.tsx`) takes optional `apiBase`,
`returnPath`, and `dataAttrPrefix` props (all defaulting to the manager behavior) so the
vendor payment-methods modal reuses it instead of forking the whole component.

**Demo-mode mock.** `PortalStripeConnectPanel` now short-circuits in `isDemoModeActive()`:
`loadStatus` returns a canned "already connected" `ConnectStatus` instead of leaving status
`null`, and `startConnect` shows a toast instead of opening a real Stripe popup/fetch — this
also incidentally fixes the same latent gap on the manager's demo Payments page (clicking
"Link"/"Update" there previously hit the real (unauthenticated, in `/demo`) API and 401'd).

**Payouts are best-effort, never block the bookkeeping flow.** `payoutVendorForWorkOrder`
(`src/lib/stripe-vendor-payout.ts`) is called from `/api/portal/work-orders/approve-pay` right
after the existing bookkeeping-only `markWorkOrderPaid` write. It attempts a
`stripe.transfers.create` (destination = the vendor's Connect account, amount = the work
order's `vendorCostCents` labor cost — materials are not transferred, they're the manager's
own expense) and always writes exactly one `vendor_payouts` row per work order on this rail (`status:
"paid"` with the transfer id, or `"failed"` with a human-readable reason for any error: no
Connect account, incomplete onboarding, Stripe not configured, insufficient platform balance,
etc.). It never throws — approve-pay's manager-facing "Approved and paid." always succeeds
regardless of payout outcome, and a failed payout is surfaced to the vendor (with a link back
to Settings) rather than to the manager.

**Invoices/work history reuse the existing Completed tab.** No new top-level portal section
was added; `vendor-work-orders-panel.tsx`'s Completed tab renders an "Invoice" block per row
(labor + materials from the work order's own `vendorCostCents`/`materialsCostCents`, the same
fields `approve-pay` already logs as expenses) plus the matching `vendor_payouts` row's status,
fetched via `GET /api/vendor/payouts` (vendor's own rows only, no join — the client already has
full work-order context from `readVendorWorkOrderRows()`).

**An accepted bid's `amount_cents` is the immutable payout anchor — nothing may overwrite it
after acceptance.** `approve-pay`/`payoutVendorForWorkOrder` trust `work_order_bids.amount_cents`
of the `accepted` bid as ground truth for the real Stripe transfer, precisely so a forged
request body can't inflate a payout. `/api/portal/work-orders/set-vendor-price` (the vendor's
own pre-"mark done" price-entry route) must check the bid's status *before* writing anything and
return 409 if it's already `"accepted"` — do not let it fall through to updating
`work_order_bids` or `portal_work_order_records.row_data.vendorCostCents` in that case. It may
still set a price when there's no bid, or the bid is merely `"submitted"` (not yet accepted). A
regression here shipped after the fix commits (`e07b70c`, `eac1439`) added this exact anchoring
invariant — see `tests/integration/portal/set-vendor-price.test.ts` for the guarding tests.

## The payout timeline, and the one way to pay a vendor twice (PRP-276)

The vendor's Payments row shows a dated timeline rather than a bare status
label: **invoice approved → payout created → transfer sent → paid out /
failed / skipped**, built by `vendorPayoutTimeline` (`src/lib/vendor-payout-timeline.ts`)
from data already on the `vendor_payouts` row and its work order. A step whose
timestamp is genuinely unknown renders as "—"; nothing here guesses a date.

A payout is unique per **(work order, invoice)**, not per work order
(`vendor_payouts_work_order_invoice_unique`,
`20261004140000_vendor_payout_work_order_invoice_unique.sql`). A service can carry two vendor
invoices — the job's own bill and the estimate-visit fee (`VISIT-<bid id>`, one per bid, see
[`services-system.md`](services-system.md)) — and the older index let a paid $50 visit fee consume
the service's only payout slot, after which the job's own invoice could never be claimed
(`claim_vendor_invoice_payment` raised 23505). The replacement is strictly looser: one payout per
(work order, invoice) on the invoice rail, and still exactly one non-invoice payout per work order on
the approve-and-pay rail (a null `invoice_id` collapses to one sentinel key, since a plain unique
index treats nulls as distinct).

Database uniqueness is therefore no longer the only double-pay guard.
`vendor_payout_cross_rail_conflict` + the `vendor_payouts_cross_rail_guard` trigger
(`20261004160000_vendor_payout_cross_rail_guard.sql`) arbitrate the race in the database under a
per-work-order advisory lock, and `findBlockingVendorPayout`
(`src/lib/work-order-approve-pay.server.ts`) is the friendly pre-check in front of it: it refuses on
any payout that already moved money for the job, across both rails.

**A service is paid once, through one rail, and there is no override.** `approve-pay` answers
**409** with `code: "existing_payout"` naming the existing payout and the rail that holds it
("already paid through Approve + pay" / "through the vendor's invoice") whenever one is `pending`
or `paid`; the invoice rails (offline, balance, Stripe) answer 409 the same way. The client's
warning card is the courtesy and disables the pay button; the 409 is the guard
(`src/lib/vendor-payout-guard.ts`). The earlier
`acknowledgeExistingPayout` escape hatch (and its `vendor_double_pay_acknowledged` audit row) is
gone: once the database arbitrates, a second payout for the same job cannot be inserted at all, so
an acknowledgement could only ever write an audit record for a payment that would never happen.

The only remaining failure classes are told apart rather than collapsed into the refusal: a
payout claim that fails for any reason other than "a row is already there" answers **500** with
the real error, and a checkout that never starts hands its claim back so the job stays payable.
On the invoice rails the same split is carried by `VendorInvoicePaymentRefusal`
(`src/lib/vendor-invoices.ts`): a deliberate no (cross-rail double pay, wrong status, not this
manager's invoice, or a `VP409` / `P0001` raise from `claim_vendor_invoice_payment` /
`manage_outgoing_invoice`) answers **409**; a database fault answers **500** and is logged. Telling
a manager "already handled" when PropLane simply broke is the one answer that stops them retrying
a payment that never happened.

**Every rail claims before it charges.** Approve + pay claims (`claimWorkOrderPayout`), the
offline and balance invoice rails claim (`claim_vendor_invoice_payment`), and the Stripe direct
invoice rail claims too, at the moment the embedded checkout opens — a job-linked invoice reserves
the payout before the card is touched, so Approve + pay and the other invoice rails are refused by
the database while the attempt is open. Checking without claiming was the one hole left: a manager
could open the checkout, run Approve + pay, and then complete the card payment — the second charge
went through and only its bookkeeping was refused, after which the retry lost the payout row and
the vendor's ledger credit outright.

A held claim cannot outlive its attempt. The session carries `expires_at` (30 minutes, Stripe's
floor), and `releaseInvoicePaymentClaim` (`src/lib/vendor-invoice-claim.server.ts` — the one owner
of that undo) hands the claim back on a failure to open the session, on
`checkout.session.expired`, and on `checkout.session.async_payment_failed`.

**One Stripe session per claim, and only that session may give the claim back.** The idempotency
key is `vendor-invoice:<invoice>:<claim>`, not invoice-wide: Stripe keeps a key for 24 hours and
replays the first response, so a key that outlived the 30-minute session handed an abandon-and-retry
the dead session's client secret and stranded the fresh claim — leaving the invoice unpayable,
unschedulable and undeletable by every rail. A re-submit of the same claim still replays one
session; a new claim gets a new one. The claiming session id is stamped on
`vendor_invoices.checkout_session_id`, and releasing is a compare-and-swap on `payment_claim` (plus
that session id when the caller knows it), so a replayed `expired` event for an abandoned attempt
is a no-op rather than freeing a live payment's claim. The pending `vendor_payouts` row is swept
only once nothing holds the invoice and it is unpaid — an unconditional delete crossed rails: a
replayed `stripe` expiry wiped the balance rail's payout row while `payment_claim` stayed
`balance`, `settle_vendor_invoice_payment` then flipped zero rows, and the payout record vanished
along with the block on Approve + pay.

**Only Stripe decides whether a session is dead.** The body `createAxisAchCheckoutSession` returns
may be a 24-hour idempotency replay of this claim's first request, so its `status` and `expires_at`
describe the session as it was *created*. When that body looks unusable the rail retrieves the live
session and acts on it: genuinely `expired` releases the claim (scoped to that session id);
`complete` keeps it and answers 409 "already processing", because an ACH debit settles for days
with the session complete and the invoice still `approved`, and that claim is backing real money;
a lookup that cannot be completed also keeps it. Trusting the replayed `expires_at` released a
claim mid-debit and let Approve + pay pay the vendor a second time.

**Every claiming rail releases on every no-money-moved failure** — Stripe on a failed session
start or a dead session, balance on a refused ledger move, and offline when `settleInvoicePayment`
refuses or faults (the release's `.neq("status", "paid")` makes it a no-op if the settle RPC had
actually committed). A release that cannot finish **throws**: the webhook answers 500 and Stripe
redelivers, because nothing else ever runs the sweep — the session has already fired its one
`expired` event, and a retried payment goes through `claim_vendor_invoice_payment`, whose
unguarded insert would hit the (work order, invoice) unique index and surface a raw 500. The paid webhook
converts the held claim into the settled payout through the same `settleInvoicePayment` the other
rails run, and every write it does is keyed on the claim rather than on the invoice's status, so a
retry after a failed write redoes it instead of skipping it.

`settleOnly` is the webhook's own flag — it records a payment Stripe already took, so it skips the
guard and moves no money. It is never read from a request body: `POST /api/portal/work-orders/approve-pay`
builds the core's input field by field from an allowlist (a compile-time `as {...}` strips nothing
at runtime), and only `completeVendorPayFromStripeSession` passes it.

## A failed payout is told to somebody

`payoutVendorForWorkOrder` returns a `VendorPayoutOutcome` (`paid` / `failed` /
`skipped`, with the amount and the reason). It never throws — the manager's
approve-pay bookkeeping succeeds whichever way the transfer goes — so that
return value is the ONLY way anything downstream can learn the vendor is owed
money.

`work-order-approve-pay.server.ts` acts on it:

- the **vendor** gets "approved — payout pending" naming the amount and telling
  them to finish connecting their payout account, instead of the "approved and
  paid" notice that would leave them owed money believing it was on the way;
- the **manager** gets "Payout pending for <job>", because their books say paid
  and nothing else on screen would ever say otherwise.

The retry itself is automatic: `retryFailedVendorPayoutsForVendor` runs when the
vendor's Connect status resolves as payment-ready
(`/api/vendor/stripe-connect/status`), so completing onboarding a day later
sends the money with no one re-approving the job. Only failures whose reason
matches `RETRYABLE_VENDOR_PAYOUT_FAILURE` are re-driven.

Coverage: `tests/unit/stripe-vendor-payout.test.ts`.

# Vendor portal (Phase 5: reviews)

A manager (or a co-manager with `services` granted at `edit`) leaves one
star-rated review per service that is **completed or at least estimated** (a
`work_order_bids` row by that service's vendor, or the vendor's own
`vendorCostCents`/`vendorPriceSetAt` — `vendorHasGivenEstimate`), re-derived
by the POST route from the DB (422 when neither; 403 for another workspace or
a `vendorUserId` that is not the service's vendor); the vendor record's Add
review dialog picks among those services. The reviewer may change their own review for
`VENDOR_REVIEW_EDIT_WINDOW_DAYS` = **14 days** — `canEditVendorReview` is the one decision behind
the Edit review menu item, the dialog and the PATCH route, and the route additionally filters on
`vendorReviewEditWindowFloorIso()` so the window holds in the database too; an unreadable
`created_at` fails closed. Nobody but the reviewer ever edits one, and the vendor
may reply once. `vendor_reviews`
(`supabase/migrations/20260925000000_vendor_reviews.sql`), unique on
`work_order_id`, keyed by `vendor_user_id` rather than
`manager_vendor_records.id` — same reason as `vendor_invoices`/`vendor_payouts`
/`work_order_bids`: a manager's own directory row isn't stable across the
several managers one vendor may work for. Eligibility, the edit window, the
aggregate, and the cross-workspace redaction (a vendor's reviews are shown to
every workspace that hired them, but another workspace's own review reads as
`"A PropLane manager"`) are all pure functions in `src/lib/vendor-reviews.ts` —
re-derived server-side from fetched rows, never the request body. Surfaces:
the vendor record's Reviews tab (`pro-vendor-detail.tsx`, alongside the
pre-existing, unrelated resident "was this fixed?" rating block — don't merge
them), a `★ 4.6 · 12` glyph fact on the Vendors list row (never a pill), a
"Leave a review" record-header action on a completed service, and the
vendor's own `/vendor/reviews`.

## What a vendor is messaged about without anyone typing (comms-safety-0929)

A vendor now hears, in their portal Communication (and by email and, with consent, text), about three
moments that used to be silent. Full contract: [`automated-communication.md`](automated-communication.md)
§ Vendor auto-messages.

- **A new service for their house and trade** (`vendor_new_service`) when they are the manager's
  preferred vendor for it. It is a real offer: it appears in Services with Accept / Decline, and the
  message says so. Facts only; the resident's name and phone arrive after they accept.
- **"You were assigned …"** (`vendor_assigned`) the moment the manager (Services panel) or the
  Assistant (`assign_vendor`) puts them on a service. A bid accept or a one-tap dispatch already sends
  "accepted" / "scheduled", so those never send a second message.
- **"New task from …"** (`task_assigned_vendor`) when a task is assigned to them.

Rules that hold for all three: sent as the manager from the workspace's own number and work address,
copy says "service" (never "work order"), one delivery key per assignment (a retry sends nothing, a
reassignment does), the text needs the vendor's recorded consent and no STOP and waits for the
vendor's own quiet hours (default 8pm–7am; an emergency texts through only if they kept "emergencies can
text me anytime" on), and the in-app message is never gated by any of it. Vendor texts go through
`enqueueOwnerSms` with `purpose: "vendor_conversation"` (the same ledger as the vendor assistant),
not the resident path that used to refuse them with `managed_sender_scope_required`.


## Vendors text through the manager's number (Oct 6)

A vendor has **no PropLane number** (the work-number claim, candidate search and
Communication card are retired; the sponsored work email stays). Managers text the
vendor's own saved phone from their workspace work number (`sms-system.md` § Vendor
texting). What the vendor does:

- **Verify the phone** with a 6-digit code (the user-generic `/api/manager/phone`,
  shown by `PortalTextNotificationsBlock`): Settings > Messaging, the onboarding
  page, and the portal-wide notice (`VendorMessagingSetupBanner`, cleared by
  `profiles.phone_verified_at`, never by a typed phone).
- Verifying links the history: every conversation a manager had with that number
  appears in their Communication, one per manager workspace, earlier texts included
  (`communication-inbox.md` § A vendor's texts are in their conversation). A number a
  second account also verified links to neither.
- They answer by text to that manager's work number or in the app; the manager sees
  one conversation either way. STOP stops every text from that manager's workspace.
