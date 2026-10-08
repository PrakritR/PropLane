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

**Jobs board retired (C152/C153 superseded) - then partly reversed Oct 6, see "The work board is back" below.** A standalone `/vendor/jobs`
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

## The work board is back, scoped to published services (vendor-work-share-1006, Oct 6)

**This reverses the Sep 26 cut above, deliberately and narrowly.** The retired board browsed every open job of every
workspace (`work_order_open_listings`). The new one shows ONLY a service a manager explicitly published, and the
old table stays dead: the flag is `row_data.published` on the service itself. The standing rule "a vendor never
browses another workspace's jobs" now reads: **never beyond what a manager published, and only through the
allowlist below.**

- **Find work** is the fifth Services tab (`/vendor/work-orders/find-work`), beside Open - Assigned - Scheduled -
  Completed, which stay the one service vocabulary (the fifth is not a stage, `VENDOR_FIND_WORK_LIST_TAB`).
  Signed-in vendors only (Decide #1): `GET /api/vendor/work-board` answers 401/403 otherwise; there is no public
  board page.
- **Who can request (Decide #2):** any ONBOARDED vendor with a trade and a service area
  (`vendorIsOnboardedForBoard`, `work-order-marketplace-match.server.ts`). A license or insurance is not required;
  the manager sees what the vendor has on file when deciding on a bid. The manager's own "send to nearby PropLane
  vendors" broadcast keeps its stricter licensed + insured rule.
- **What a vendor sees before hire is `publicServiceProjection`** (`src/lib/public-service-projection.ts`): title,
  trade, general area (`workOrderGeneralArea`), description, preferred dates, "up to" budget, photos only when the
  manager ticked Share photos, the manager's display name, and an opaque `ref`. It is an ALLOWLIST with a build-time
  key list (`as const satisfies readonly (keyof ...)[]`) and a leak test (`tests/unit/public-service-projection.test.ts`):
  no address, unit, resident, entry notes, cost, work order id or manager id. A new `DemoManagerWorkOrderRow` field is
  private until someone adds it there. Do NOT reuse `projectWorkOrderForOfferedVendor` (a deny-list) for a stranger.
- **Requesting a job** (`POST /api/vendor/work-board`) is the same thing a manager's Send job makes: a roster row on
  the manager's workspace and a `sent` row in `work_order_vendor_offers`, written service-role only
  (`requestBoardJob`). Then offer -> estimate / bid -> approve runs unchanged: only a submitted bid is approvable, one
  accepted bid, the accepted amount immutable, vendors scoped by `vendor_user_id`. The ref is re-checked against the
  vendor's trade and area, so a ref is not a way around the list. A service leaves the board the moment it is hired
  (`acceptWorkOrderBid` clears `published`), completed, cancelled or unpublished; a vendor the manager removed
  (`withdrawn` offer) cannot ask again.
- **Throttles:** `BOARD_REQUESTS_PER_VENDOR_PER_HOUR` per vendor, `MAX_BOARD_REQUESTS_PER_SERVICE` per service.
- **Contact is held until they bid (Decide #3).** The roster row made for a board or link vendor carries
  `origin` and `contactHeldUntilBid: true` with a blank phone and email (a texted vendor's phone is the one the
  manager typed). `submitWorkOrderBid` calls `revealHeldVendorContact`, which writes the vendor's own business-profile
  contact onto that row. An estimate or a message does not release it. The address is never shown before hire.
- **Three options wherever a vendor sees a job** (the public page, Find work, their own Open services,
  `src/lib/vendor-job-choice.ts` + `VendorJobChoiceBar`): **Needs an estimate visit** (the existing Estimate & bid
  section on Book visit), **Bid now** (the same section on Submit bid) and **Message the manager** (the service's own
  Communication tab, the in-app thread whose `recordRef` is the service). All three first make the vendor's offer;
  none is a new bid path.

### The texted service link

A manager texts a service to a phone from the service header (Send to phone) with
`POST /api/portal/service-share-link/send`: ownership is re-derived from the row, the phone is normalized, "I work
with this vendor" is required on the first text to a number (`GET /api/manager/vendor-text-consent?phone=` tells the
pop-up whether to show the box), the number joins the Vendors list, and the text goes out through the SAME vendor-texting
path as the manager compose (`sendManagerConversationSms` for a roster vendor: attestation, the identification + STOP
footer on the first text, `vendor_conversation` consent evidence, credit reservation, the vendor-thread projection;
STOP always wins). The link is `/s/<token>`: `service_share_links` stores only the SHA-256 of
the token (`token_hash`), 14-day expiry, revocable, access count, a per-manager daily text cap, and per-IP / per-token
limits on the public page. `/s/<token>` is `noindex`, no-store, and answers one neutral 404 for an unknown, expired or
revoked token. A link never creates an account, an offer or a bid by itself.

Sign-up from the link: the page parks `{token, choice}` in the `pl_svc_link` cookie and sends the visitor to
`/auth/create-account?mode=create&role=vendor` (or sign-in); the vendor portal layout mounts
`PendingServiceLinkRedeemer`, which calls `POST /api/vendor/service-link/redeem` once signed in (email or Google).
Redeem makes the roster row (with the texted phone) and the `sent` offer and opens bidding. A link is bound to its
FIRST redeemer. **Phone verification is a hook point** (`serviceLinkPhoneVerificationHook`, vendor texting owns the
verification) and records nothing until that lands.

Local SMS proof: `SERVICE_LINK_SMS_SANDBOX=1` under `next dev` queues the text for real (so it reaches the vendor
thread) and captures only the carrier hand-off in the SMS test transport; an account with no ready work line falls back
to capturing the whole send. It is inert in any deployed build.

### The vendor Services list and service record (vendor-portal-redesign-1006)

Every Services tab (Open · Assigned · Scheduled · Completed · Find work) is the shared row; stage actions live only in
the row's ⋯ (`vendorServiceActions`: Open Submit bid · Book visit · Decline; Assigned Schedule · Message the manager;
Scheduled Reschedule (asks the manager) · Complete; Completed Send invoice). There is no bulk selection. The service
record uses the resident-record anatomy: header Message the manager · the primary next step · ⋯ (the other stage
actions), the stepper under it, rail Job (Overview · Estimate & bid · Schedule), Money (Invoice · Payments), Records
(Communication · Documents). Estimate & bid answers are underline tabs (`vendorBidTabs`: Bid · Estimate · Estimate
visit · Decline) with the commit button in the card footer. Guard: `tests/unit/vendor-services-anatomy.test.ts`.

## Settings > Integrations and the Calendar link (Oct 6)

Settings > Business has an **Integrations** page (`VendorIntegrationsSettings`): Google Calendar connect, a private
revocable iCal **Calendar link** of the vendor's scheduled jobs (addresses only once hired), and Request access rows for
Jobber, Housecall Pro and Thumbtack. The Calendar band's calendar-sync icon opens it. Token design, privacy and the
tables: [`google-integrations.md`](google-integrations.md) § Vendor Integrations page and Calendar link.

## Work number & email (Oct 6)

Any vendor with a verified phone (`profiles.phone_verified_at`) can claim a PropLane work number, free: Settings >
Account > **Work number & email** (`VendorWorkNumberSettings`) shows the number, the sponsored work email, a
"Forward texts to my phone" toggle (default on), "Texts this month X of 1,000" and "Service fee 3% of payouts through
PropLane". Managers' texts to that vendor arrive on the number, are kept in the vendor's PropLane Communication and are
forwarded to the verified phone labelled `[<Workspace>] ...`; the vendor's replies go to the manager they last
talked to, or get a numbered "Reply to" prompt. A number idle for 60 days is released; the fee is the only cost. The
routing rules, cap, release and dry run: [`sms-system.md`](sms-system.md) § Vendor work number; the fee:
[`financials.md`](financials.md) § PropLane service fee.

### PropLane Number: the number is a $5/month subscription (Oct 8, flag `NUMBER_SUBSCRIPTION_ENABLED=1`)

The vendor account stays free. With the flag **off** everything above is unchanged (free number, 1,000-segment fair use).
With it **on**, the number, the sponsored work email's number half, the AI on the number and the vendor's texts
from it belong to a **PropLane Number** subscription ([`comms-billing.md`](comms-billing.md) § PropLane Number
and § Vendor side). The work **email** stays free and is not part of the gate.

- **Gate = `numberServiceEntitled`** (`active` or `past_due`), never a status string of your own
  (`vendorNumberEntitled`, `src/lib/number-subscription/vendor-number.server.ts`). It is checked in
  `POST /api/vendor/work-identity` (SMS), `POST /api/vendor/work-identity/candidates` (so no claim token is minted
  for a non-subscriber), `setupVendorWorkIdentity` (the one purchase path) and
  `provisionVendorWorkNumberAtSignup` (finishing onboarding returns `skipped: subscription_required`). The route
  answers 403 `subscription_required`; an unreadable subscription is a 503, never a free claim.
- **Settings > Work number & email and the onboarding last step** (the same `VendorWorkNumberSettings`, rows in
  `vendor-number-billing.tsx`): not subscribed shows **Your own work number - $5 / month - Subscribe** (to Stripe
  Checkout) instead of the claim; subscribed shows the number, **PropLane Number - $5/month - renews <date>** with a
  Manage icon (Stripe portal), and **Credit - $X left this month - $Y bought** with **Buy credit** ($5-$500 whole
  dollars, one purchase id per attempt). At $0 the row reads **Out of credit** (texts and AI replies are paused until
  the 1st or until the vendor buys credit). A held number of a lapsed vendor shows **Paused** beside Subscribe.
  `/demo` and a flag-off server render none of this.
- **Provisioning on activation.** The signed Stripe webhook, only after it recorded the subscription `applied`,
  calls `provisionVendorNumberOnActivation` for a vendor with a verified phone: the owner comes from our
  `number_subscriptions` row (never event metadata), the claim key is seeded with the Stripe subscription id (a
  replay buys once; a new subscription after a released number buys a new one), and a failure never fails the
  webhook - the vendor can still claim from Settings.
- **Lapsed (canceled / incomplete).** The number is paused: no outbound text, no AI, `sendReady` false with
  `blockedReason: subscription_required`; inbound still lands in the inbox; a manager's text falls back to the
  vendor's own phone from the manager's work number (`getRoutableVendorNumber`, used by `providerDestinationFor` and the
  thread header). After **30 days** lapsed the cron (`/api/cron/release-vendor-work-identities` ->
  `releaseLapsedVendorWorkNumbers`) releases the number; entitlement is re-read right before the remove. A paying
  vendor's quiet number is not idle-released. A number held from before the flag by a vendor with no subscription row
  is paused when the flag turns on but has no lapse clock; the 60-day idle rule still applies to it.
- **Deleting the account cancels the Stripe subscription first** (`cancelNumberSubscriptionForAccount`), in every
  path that purges `number_subscriptions`: self-delete, admin delete, the vendor/resident portal delete and the
  account-recovery archive. A Stripe failure aborts the delete (retryable); already-canceled counts as done.

### Number at signup, AI info, and the AI on the number (Oct 8)

Finishing onboarding (`vendor-onboarding.tsx` Finish -> `PATCH /api/vendor/business-profile` with
`finishOnboarding: true`) gives a vendor with a verified phone a number automatically, picked on the
server near the phone's area code (`provisionVendorWorkNumberAtSignup`); the client never names a
number. The response carries `workNumber`; when one was allocated the page shows "You're set up" with
the number (copy icon) and an AI info "Set up" link, otherwise it goes to the dashboard and Settings >
Work number & email keeps the picker. The whole path stays behind the existing vendor-number gates and
enables nothing by itself. Settings > Business > **AI info** (`vendor-ai-info-settings.tsx`) holds
Hours, Rates, How to book, Emergencies and Anything else (`vendor_business_profiles.ai_info` jsonb, five
keys, 1000 characters each, validated in `parseVendorAiInfoPatch`; saved through the business-profile
route with the service role pinned to the signed-in vendor), plus the read-only service area and trades.
Texts from clients and residents to the number get an answer-only AI built from those answers; managers
never do. Rules, limits and hand-off: [`sms-system.md`](sms-system.md) § Vendor-number AI.

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

**Every rail claims before it charges.** Approve + pay claims (`claim_work_order_vendor_payment`), the
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
`created_at` fails closed. Nobody but the reviewer ever edits one. The vendor replies
through POST (first reply only, 409 over an existing one) and edits that reply through
PATCH (`/api/vendor/reviews/<id>/reply`, scoped to their own review and to one that already
has a reply) — Reviews ⋯ offers **Reply** / **Reply with a quick reply** until a reply
exists, then **Edit reply**. `vendor_reviews`
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

# Vendor portal redesign: Reviews, Payments, Settings and quick replies (approved plan vendor-portal-redesign-1006)

The vendor lists now follow the manager list anatomy (`ui-page-structure.md` § 2): one header card
(tabs with counts · search · icon utilities · the round blue + where the list has a create), shared
rows (tile · title · place line · glyph facts · figure · one ⋯), no pills and no button rows under a
row. `tests/unit/vendor-redesign-row-anatomy.test.ts` guards it.

**Reviews** (`vendor-reviews-panel.tsx`). A stats strip over the header card — Average rating,
Reviews, Needs reply, Response rate, every figure derived from the rows — then tabs All · Needs
reply · Replied, rows `★ tile · reviewer · the review · date · ✓ Replied · ⋯`. The reviewer reads
**"A PropLane manager"** and no service or area is shown: the vendor-safe projection
(`VENDOR_REVIEW_PUBLIC_SELECT`) deliberately carries no manager, workspace, property or work-order
link, and the redesign did not reverse that. Reply opens a small pop-up with the review for context,
a ⚡ quick-reply menu and **Save reply** in the footer.

**Payments** (`/vendor/financials/income`, `VendorFinancesPanel`) is one tab of Finances (below) and carries no
balance card; refunds live on Finances → Refunds, and the per-payment Refund on a payout record page stays hidden until the
Payments tab wires `VendorRefundModal` — the route is off by default (`VENDOR_REFUNDS_ENABLED`) and answers 409
`VENDOR_REFUND_PAUSED`; the refund itself runs on the central refund rail, see `financials.md` § Vendor refunds. Tabs are **Pending · Paid · Overdue**
(`vendorPaymentBucket`, `src/lib/vendor-payments.ts`): Paid = a paid invoice or payout; Overdue = an
**unpaid, non-rejected invoice whose due date is before today** (a payment due today is still
Pending; an invoice with no due date can never be overdue); everything else Pending (rejected
invoices and failed payouts stay there because the vendor must act on them). The due date is the
manager's bill's `due_date` for the invoice (`vendor_invoices.bill_id` → `manager_bills`); the GET
`/api/vendor/invoices` route projects only that one date as `dueDate`, never the bill. Row ⋯:
View invoice (View payment on an income row) · Edit · Retract invoice (a submitted invoice; named so it is never read as withdrawing money) · Download ·
**Refund** · Message the manager (opens Communication with New message, `?compose=1`). Refund shows only when
`isVendorPaymentRefundable` (a settled payment with gross left) AND `VENDOR_REFUNDS_ENABLED` is on — the flag reaches
the client as `refundsEnabled` on the one balance snapshot, never a client guess — and opens the Refund a payment
pop-up (`VendorRefundModal`, owned by the refund path) on that payment. The payout record page's header still hides Refund.

## Finances: one page, three tabs (vendor-banking-1006, Oct 7; combined vendor-finances-1008)

**One page, one nav row (vendor-finances-1008, captain Oct 8).** Finances is a single sidebar / More row with no
sub-items (`financials` declares `tabs: []`). `VendorFinancesPage` (`vendor-finances-balance.tsx`) is the whole
page: the four balance cards (below), then one `RecordTabBand` header card with the tabs **Overview · Payouts ·
Refunds** and the Bank + Withdraw icons. The tab is the URL segment, handled in `render-portal-section.tsx`:
`/vendor/financials/overview` (default for bare `/financials`), `/payouts`, `/refunds`. Aliases: `/financials/balance`
(bare) -> `/payouts`; `/financials/balance/<id>` is still a withdrawal's own page; `/financials/payouts/<id>[/<tab>]`
is still a payment's record page; `invoices` bare / `income` -> Incoming payments, `statements` / `tax` -> Documents,
`/vendor/payments` -> Incoming payments. Overview adds only what the cards do not show (Owed to you, Paid this
year, this month's earned / spent / profit / jobs, By manager); Refunds mounts `VendorRefundsPanel embedded`, whose
round + sits in the band. Settings > Payouts keeps only **Bank accounts + Schedule** and links to the Payouts tab.

**One server snapshot feeds every number**: `GET /api/vendor/payouts/balance`. `deriveVendorFinancesFigures`
(`src/lib/vendor-banking/finances.ts`, pure) turns it into **Available · Pending · Held (with its reason: until you
add a bank / until identity is verified / being released) · On the way · Owed to PropLane** (provider deficit plus
outstanding recovery); `deriveVendorFinancesBanner` names the exact reason money cannot move and the one fix (Add
bank, Reconnect on a 409 `needsRelink`); `vendorWithdrawDisabledReason` is why Withdraw is disabled — a disabled
button always says why (it is in the icon's name). Header icons on the card: **Bank · Withdraw only**.

- **Payout history** (`vendor-finances-balance.tsx`): rows from the snapshot's history; a row opens
  `/vendor/financials/balance/<payoutId>` (amounts, destination, dates, status) whose Receipt opens
  `/print/vendor-withdrawal/<id>` (scoped to the signed-in vendor's own `stripe_payouts` row; Print → Save as PDF).
- **Withdraw sheet** quotes the Instant fee from **one constant**: `VENDOR_INSTANT_WITHDRAW_FEE_BPS` (1.5%) and
  `…_MIN_CENTS` ($0.50) in `platform-fees.ts`; `vendorInstantWithdrawFeeQuoteCents` is the flag-free formula the
  server (`vendorInstantWithdrawFeeCents`) and the sheet both call, and the label is derived
  (`VENDOR_INSTANT_WITHDRAW_FEE_LABEL`). Standard is free. The sheet's submit is guarded by a ref so a double click
  cannot create two payouts (the server's pending-claim index is the real guard).
- **Ledger**: `POST /api/vendor/payouts/create` writes the withdrawal to the vendor ledger
  (`recordVendorWithdrawalLedger`, idempotent on the payout id): a `withdrawal` debit for what the bank receives
  and, for Instant, a `platform_fee` debit with source `withdrawal`. The Instant fee is quoted, shown and booked;
  collecting it to the platform account is not wired (the payout request is for the net amount).
- **Statements** (`vendor-statements-panel.tsx`, `vendor-statement-modal.tsx`): one row per month with activity —
  opening, closing, Matches Stripe — opening the month's lines (`GET /api/vendor/payouts/statement?month=`), PDF
  (`/print/vendor-statement/<yyyy-mm>`) and CSV (`?format=csv`, formula-safe). Every ledger line carries an event type
  from `vendorStatementEventType` (`statement-events.ts`): charge · fee · hold · transfer · withdrawal · instant fee ·
  refund · dispute · hold expiry · adjustment, derived from `kind` + `source` (a dispute is an `adjustment` whose
  description starts "Dispute"; no ledger constraint was widened). A read failure is an error with Try again, never
  "No activity yet". Opening balance = everything before the month.
- **Tax info** (`vendor-tax-panel.tsx`, `/api/vendor/finances/tax`): one W-9 per vendor **account** in
  `vendor_account_tax_profiles` (PK `vendor_user_id`, RLS on, no client grant; migration
  `20261007010000_vendor_tax_profiles.sql`). The TIN is AES-256-GCM ciphertext (`tin-crypto.ts`,
  `FINANCIALS_TIN_ENCRYPTION_KEY`; the route answers 503 without the key, never stores plaintext) plus last four —
  only the last four ever leaves the server. Editing without retyping the TIN keeps the stored one. The save mirrors
  the same ciphertext into the legacy per-manager `vendor_tax_profiles` rows the manager's 1099 export reads. The tax-year
  summary (earnings, fees, refunds) comes from the ledger; the 1099 line uses `threshold1099Cents` ($600 before 2026,
  $2,000 from 2026) on earnings less refunds.
- **Refunds** tab mounts `VendorRefundsPanel` (`vendor-refunds-panel.tsx`), owned by the refund path.

Coverage: `tests/unit/vendor-finances-*.test.ts(x)`, `tests/unit/vendor-banking/{finances,statement-events,tax,withdrawal-ledger}.test.ts`,
`tests/unit/vendor-payments-refund-item.test.tsx`.

**Gear in every vendor list band** opens the matching Settings page, never a pop-up
(`vendor-settings-pages.ts`, `VendorSettingsGear`): Services → Trades & service area, Payments →
Payouts, Reviews → Profile, Communication → Quick replies. `VendorSectionSettingsModal` survives as a
redirect shim so the Services panel's existing gear lands on Trades & service area until that panel
renders `VendorSettingsGear` itself.

**Vendor Settings** (`/vendor/profile?tab=<page>`, `vendor-settings-panel.tsx`) uses the manager
Settings layout: a rail (desktop) / link-row cards (phone) grouped **Profile** (Profile, Login &
security, Preferences, Feedback, Account) · **Business** (Business details, Trades & service area,
Licenses & insurance, Availability) · **Money** (Payouts, Invoicing) · **Communication** (Phone &
notifications, Quick replies). Existing content moved, not copied: Business details = the old
Business profile + Work contact & email; Trades & service area = the old Work capabilities + the
service-area field; Phone & notifications = Verify your phone + Notifications; Profile = the old
Directory listing. `payouts` and `messaging` keep their ids (setup banners and emails link to them);
`work*`, `workspace*` and `notifications` alias forward (`VENDOR_SETTINGS_TAB_ALIASES`).
`/vendor/settings`, `/vendor/settings/<tab>` and `/vendor/settings?tab=<tab>` are the same address:
`renderPortalSection` redirects them to `/vendor/profile` carrying the resolved tab (an unknown or
absent tab lands on Profile; a deeper path 404s), so a typed URL or an old link does not dead-end
(`tests/unit/vendor-settings-redirect.test.ts`). Licenses &
insurance edits the profile's license and coverage fields (certificates still upload from
Documents); Invoicing shows the W-9 on file read-only — there was no prior vendor invoicing setting.

**Quick replies.** Each vendor's own saved messages, a starter set until they save a list of their
own ("On my way", "Running 15 minutes late", "Need photos of the issue", "Can I come by for an
estimate?", "Job complete — invoice sent"). Stored on the vendor account in
`notification_preferences.row_data.vendorQuickReplies` (the per-user JSON row vendor notification
settings already use — **no migration**; `saveNotificationPreferences` preserves the key beside
`resident` and `vendor`). `GET/PUT /api/vendor/quick-replies` resolves the vendor from the session
(`resolveVendorPortalUserId`) and never reads an id from the request; PUT replaces the whole list
(add, edit, delete and reorder all save as one write; max 20 replies, 500 characters each; an empty
saved list stays empty rather than reverting to the starters). Settings → Quick replies manages them
through the row ⋯ (Edit · Move up · Move down · Delete). **`QuickReplyMenu`**
(`quick-reply-menu.tsx`) is the reusable ⚡ picker: `onPick(text)` hands the text to the caller, which
inserts it with `insertQuickReplyText` so it stays editable. It is mounted in the Communication
composer (`variant="composer"`) and the review reply; the bid note can drop it in with
`<QuickReplyMenu onPick={...} />`. Coverage: `vendor-quick-replies*.test.ts(x)`.

## Refunds, disputes and money notifications (vendor-banking-1006 part B)

**Refunds tab** (`VendorRefundsPanel`, `src/components/portal/vendor-refunds-panel.tsx`, mounted by the Finances section by
`basePath`): the vendor's refund requests (`GET /api/vendor/refunds`, scoped to `vendor_user_id`), pending · succeeded ·
failed as glyph facts on the shared record row, the round + opening **Refund a payment**
(`VendorRefundModal`): full or partial amount, a reason dropdown, and the preview *Manager gets back · PropLane fee
returned to you · From your balance*. The cap and refusals (already withdrawn, frozen by a dispute, fully refunded) come
from `GET /api/vendor/payouts/[id]/refund`; `POST` takes only the gross amount and reason and requires an
`Idempotency-Key`. The server recomputes every figure — the modal's preview never decides anything. Rules and books:
[`financials.md`](financials.md) § Vendor refunds, disputes and notifications.

**A refund the vendor cannot cover is refused, not shorted.** Released money already withdrawn is not recoverable, so the
central path refuses it (the legacy destination-charge path still records a shortfall drawn from the next payments).

**Disputes**: a dispute on a charge one of the vendor's payments settled on freezes that amount (it cannot be refunded;
the balance snapshot must subtract `readVendorFrozenDisputeCents` from what can be withdrawn), and is released when won or
debited when lost. Both the vendor and the manager are told. **Notifications** for payouts, bank, account and money held
use the automated-communication spine under the vendor's Settings → Notifications → Payments topic.
