> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Vendor portal (Phase 1 foundation)

A 4th portal role — `vendor` — sits alongside manager/resident/admin. Phase 1
covers vendor login + portal shell + work-order visibility + notifications.
Phase 2 (bidding) and Phase 3 (Stripe Connect payouts) are documented below.

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
`src/lib/inbox-recipient-scope.ts` (`vendorEmailsForManagers`,
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

# Vendor portal (Phase 2: tour → bid pricing)

Bidding lives in a new `work_order_bids` table
(`supabase/migrations/20260704130000_work_order_bids.sql`), not in
`portal_work_order_records.row_data` — the work order row only carries a
lightweight `biddingOpen` / `biddingOpenedAt` / `biddingResolvedAt` flag
(`DemoManagerWorkOrderRow` fields) plus the existing `vendorId` /
`vendorName` / `cost` fields that already model final vendor assignment.

**Single-vendor-at-a-time offer, not a multi-vendor auction.** The work
order's existing `vendorId` (`manager_vendor_records.id`) / `vendor_user_id`
column can only point at one vendor, and `/api/portal-work-orders` GET scopes
a vendor's visibility to `vendor_user_id = auth.uid()` — so only the currently
assigned vendor can see and bid on a given work order at a time. The
`work_order_bids` table itself does **not** preclude multiple bids per work
order (only `unique(work_order_id, vendor_user_id)`): a manager can reassign
`vendorId` to a different vendor and click "Invite for bids" again, and each
vendor's bid is tracked as its own row. The tradeoff: if a manager moves on to
vendor B, vendor A loses read access to that work order (and its own status
badge) even though their `work_order_bids` row still exists — acceptable for
Phase 2 per spec, revisit if concurrent multi-vendor bidding becomes a
requirement.

**Flow.** Manager assigns a vendor (existing `assignVendor`), optionally
schedules a tour visit (existing flow, unchanged), then clicks "Invite for
bids" (`manager-work-orders-panel.tsx`) — this sets `biddingOpen: true` on the
work order (mirrored to the server via the existing local-first
`updateManagerWorkOrder` → `/api/portal-work-orders` "replace" sync, same as
every other work-order field) and calls `/api/portal/send-vendor-visit-email`
with `kind: "bid_offer"` to reuse the SAME vendor resolution + email (Resend)
+ `deliverPortalInboxMessage` + audit-log pipeline as the visit-scheduled
email, just with different copy (`buildVendorBidOfferEmail` in
`src/lib/vendor-visit-email.ts`) — no second notification path was built. The
vendor submits/updates a cost + proposed-time + note bid via the new
`/api/portal/work-order-bids` route (`vendor-work-orders-panel.tsx`), which
verifies `portal_work_order_records.vendor_user_id === auth.uid()` AND
`row_data.biddingOpen === true` before accepting a write — never trusting a
client-supplied work order id to attach a bid to an unrelated manager's
record. The manager reviews bids on the work-order detail and accepts one;
the accept route (server-side, service-role) sets that bid `accepted`, every
other `submitted` bid on the same work order `declined`, patches the work
order's `row_data` directly (`vendorId`, `vendorName`, `cost`, `biddingOpen:
false`) bypassing the client mirror (the manager's browser picks it up on its
next `syncManagerWorkOrdersFromServer`), and notifies the winner (and,
best-effort, each declined vendor) via `deliverPortalInboxMessage`.

**RLS** (`work_order_bids_vendor_read` / `work_order_bids_manager_read`):
BOTH sides are `FOR SELECT` only — vendor by `vendor_user_id = auth.uid()`,
manager by `manager_user_id = auth.uid()` (denormalized onto the bid row at
submit time so no join is needed). The original vendor `FOR ALL` owner policy
was replaced by `20260705120000_work_order_bids_vendor_select_only.sql`
because it let a vendor's own client INSERT bids on arbitrary work orders,
bypassing the service-role API's work-order-access + `biddingOpen` checks.
All real writes go through the service-role API exactly like every other
portal table in this codebase.

**Jobs board retired (C152/C153 superseded).** A standalone `/vendor/jobs`
section with Invited/Open tabs and a cross-workspace open-marketplace browse
(`work_order_open_listings`, `openListingId` on `work_order_bids`,
`resolveVendorWorkOrderAccess`'s `"open_listing"` access kind) previously
existed alongside Services. The captain cut it (2026-09-26): there is no open
marketplace, and no Jobs nav item — a vendor's invited-to-bid services are
just Services' own Potential tab (`vendorWorkOrderTab`'s `biddingOpen`
bucket), the same rows Services already showed. `/vendor/jobs*` redirects to
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
Dashboard login link; the vendor's balance, Pay out and schedule live on the Payouts tab of
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
own expense) and always writes exactly one `vendor_payouts` row per work order (`status:
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

Because exactly one `vendor_payouts` row exists per work order, the only way to
pay a vendor twice is to ALSO record an off-platform payment. That is now
refused rather than merely warned about: `approve-pay` answers **409** naming
the existing payout when one is `pending` or `paid`, and proceeds only with
`acknowledgeExistingPayout: true`, which writes a
`vendor_double_pay_acknowledged` row to `audit_log` before the write runs. The
client's warning card is the courtesy; the 409 is the guard
(`src/lib/vendor-payout-guard.ts`).

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
star-rated review per **completed** service, editable for 14 days; the vendor
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
