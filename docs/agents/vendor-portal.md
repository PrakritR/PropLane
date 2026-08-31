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
`/portal/relationships/vendors`, the `ManagerVendorsPanel` component under the
Team section's Vendors tab; no longer a Services sub-tab — that was
removed as redundant with the Services sub-tab)
writes a `vendor_invites` row (`manager_user_id`, `vendor_directory_id`,
`vendor_email`, status) — the invitee has no account yet, so this can't use the
`account_link_invites` Axis-ID-lookup shape; it's matched by lowercased email at
signup instead, mirroring how `manager_application_records` links residents.
`provision-vendor-account.ts` does the linking: on signup it looks up the
pending invite by email, links (or creates) the `manager_vendor_records` row,
sets its `vendor_user_id`, and marks the invite accepted. A vendor CAN also
self-serve signup from the public marketing CTA with no invite at all — they
just land with no linked manager until one exists.

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

**Unlinked-signup notice — DELIVERY-driven today, should become STATE-driven
(follow-up, not done).** A signup that finishes with no linked manager reports
why: `provisionVendorAccountByEmail` returns `unlinkedReason`
(`"invite_expired"` | `"invite_revoked"` | `null`), the vendor-register routes
turn it into copy via `vendorUnlinkedNotice(reason, { confirmed })`, and the
message is handed across the post-signup `window.location.replace` through
`src/lib/pending-notice.ts` (sessionStorage, TTL + `/vendor` destination guard,
atomic read-and-clear) for `vendor-dashboard.tsx` to render as a dismissible
banner. That banner is driven by DELIVERY — it appears only when a notice was
queued during this signup — and it should instead be driven by STATE: rendered
whenever the vendor's `linkedManagerId` is null, with the queued message merely
supplying the specific reason when one exists. Two concrete gaps remain until
then:

- The brand-new self-serve path never queues. `registerSelfServe`'s
  `confirmed === false` branch returns early after setting the inline notice on
  the "check your email" screen, so a vendor who clicks the emailed link and
  lands in the portal gets no banner — that journey still ends silently
  unlinked.
- The sessionStorage read is destructive, so a reload or a navigation before
  the vendor clicks Dismiss consumes the notice permanently. "Stays until
  acknowledged" only holds within one uninterrupted page view.

Going state-driven would make `pending-notice.ts` — the queue, its TTL and its
destination guard — redundant.

**Row-level isolation.** `manager_vendor_records`, `portal_work_order_records`,
and `vendor_tax_profiles` all gained a `vendor_user_id` column (nullable,
populated once the vendor signs up) plus a `..._vendor_read` RLS SELECT policy
scoped to `vendor_user_id = auth.uid()` — defense in depth alongside the
existing service-role API routes, matching the `auth.uid()` pattern on the
financials tables. `/api/portal-work-orders` resolves `vendorId` (a
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

# Vendor portal (Phase 3: Stripe Connect payouts + invoices)

**Connect account reuses the manager's column.** `profiles.stripe_connect_account_id`
(added for managers in `20250421120000_profiles_stripe_connect_account.sql`) is generic —
keyed by `userId` only — so it's reused as-is for a vendor's own Connect Express account
rather than adding a new column; a vendor and a manager are always different auth users, so
there's no collision risk. `ensureVendorConnectAccountId` (`src/lib/stripe-connect-account.ts`)
is a thin wrapper over the existing `ensureManagerConnectAccountId`, passing
`axisPortal: "vendor"` so the Stripe account's `metadata.axis_portal` distinguishes vendor
from manager accounts in the Stripe Dashboard.

**Vendor-specific onboarding routes.** `/api/vendor/stripe-connect/{onboard,status}` are
clones of the manager `/api/stripe/connect/{onboard,status}` routes (not a generalized single
route) because the manager routes hardcode `basePath = "/portal"` for the Account Link
return/refresh URLs; the vendor routes hardcode `/vendor/profile` instead and additionally
gate on `profiles.role === "vendor"`. The shared `PortalStripeConnectPanel` component
(`src/components/portal/portal-stripe-connect-panel.tsx`) gained optional `apiBase`,
`returnPath`, and `dataAttrPrefix` props (all defaulting to the original manager behavior) so
it could be reused for the vendor Settings → Payments panel (`variant="embedded"`, previously
unused) instead of forking the whole component.

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
