# Plan entitlements & the property cap

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Plan entitlements: the displayed plan and the enforced plan are one value

`MANAGER_PLAN_TIERS` (`src/data/manager-plan-tiers.ts`) is the advertised copy;
`src/lib/manager-access.ts` is the enforcement model. Two rules, both learned the
hard way (audit F-SET-1: Settings read "CURRENT PLAN Free · 1 property listing"
on an account with five listings and no paywall anywhere).

- **`resolveEffectiveManagerSkuTier` is the ONLY plan a quota may read.**
  `manager_purchases.tier` is `null` for an ordinary account that signed up and
  never reached pricing (`provisionPendingManagerAccount` inserts `tier: null`),
  and `maxPropertiesForManagerTier(null)` means *uncapped* — so the raw column
  reported "Free" to `getManagerSubscriptionTier` and "no limit" to the property
  cap for the same row. No committed SKU and no live Stripe/Apple grant behind
  it → Free. `GET /api/manager/subscription` exposes it as `effectiveTier` and
  derives `propertyLimit` / `accountLinkLimit` from it;
  `getEffectiveManagerSkuTier` is the server-side twin, and it returns a RESULT
  — an unreadable plan and "no committed SKU" both produce zero purchase rows,
  so collapsing them would enforce Free on a transient DB error and refuse a
  paying Business manager their sixth listing. Callers fail closed on
  `ok: false`. **A LAPSED signup trial resolves to Free here too**, so pass
  `billing` and `paidAt` alongside `tier` (`getEffectiveManagerSkuTier` reads
  both off the purchase row). The row keeps `tier: pro|business,
  billing: trial` forever — the 14-day trial expires by DATE and nothing
  rewrites it — so reading `tier` alone kept the Pro property cap and the Pro
  communication allowance for the rest of the account's life while the sidebar
  correctly said Free. The plan the product ENFORCES has to equal the plan it
  DISPLAYS. Only the signup trial is expired here: a live Stripe subscription or
  Apple grant is authoritative and is never run through date math, and waiver /
  admin / portal grants have their own authorization rules. **A live signup trial
  is not a paid account** (`billing: trial`); it cannot provision a work number.
  A validated promo waiver (FREE100 / `promo_code` on the purchase row) **is
  paid**, same as Stripe or Apple. Managers enter promo codes on checkout (and
  signup), never on the Billing & plan page.
  **Promo codes are Stripe-native, and two columns must never be confused.**
  `manager_purchases.promo_code` is the payment-WAIVER column (FREE100 /
  WAIVEPROCESS1 / onboarding grants): any non-empty value is paid access with no
  Stripe subscription behind it (`isWaiverGrantedManagerPurchase`). A code a
  customer redeems at Stripe Checkout (FREEFIRST, a staff-made code) is recorded
  in `manager_purchases.stripe_promotion_code`
  (`resolveCheckoutSessionPromoCode` -> `recordPaidManagerCheckoutSession`), which
  is display / reporting only and never grants anything. Writing a checkout code
  into `promo_code` would keep a cancelled FREEFIRST customer on paid access for
  free. The code is read ONLY from the discounts Stripe applied to the session
  (`discounts` / `total_details.breakdown.discounts`); `metadata.promo` is customer
  free text and is never recorded as a redemption. The admin Subscribers Promo bucket, the account record's Promo fact and
  the admin assistant's `subscriber_counts` read `stripe_promotion_code`; a waiver
  account stays where it was counted before. Coverage:
  `tests/unit/manager-purchase-from-session.test.ts`,
  `admin-subscribers.test.ts`.
  Omitting `billing`
  and `paidAt` keeps the older behaviour for a caller with no billing row to
  read. **Staff can extend that trial, and it is live**: with no Stripe
  subscription the end is moved by rewriting `paid_at` (the one value this
  resolver derives it from), so no reader needs to learn a second date - see
  "Per-account overrides" below. Coverage:
  `tests/unit/manager-trial-expiry-quota.test.ts`.
  **That rule has to reach BOTH halves or it is worse than not
  having it**, because the client caches what the route says: a plan the server
  could not read is reported as `planUnknown: true` with `effectiveTier`,
  `propertyLimit` and `accountLinkLimit` all `null` and `isFree: false`, so
  Properties draws no limit banner and pre-refuses nothing — the client stops
  pre-judging and the server gate, which already 500s on that path, decides.
  `manager-subscription-client.ts` does NOT cache an unknown read, or one
  transient error would freeze a Business manager at "reached your plan limit of
  1 property" for the whole session. **It caches BOTH values and they
  are not interchangeable**: `loadManagerEffectivePlanTierClient`
  (`effectiveTier`) is for the property-limit pre-checks only, because the
  server re-resolves that same value; every other client gate mirroring a server
  check that still reads `null` as legacy full access wants the raw
  `loadManagerSubscriptionTierClient`. Screenings is why — caching
  `effectiveTier` for everyone paywalled a panel `orderScreeningForApplication`
  still serves.
- **The property cap is enforced server-side, not in the wizard.**
  `assertManagerPropertyListingQuota`
  (`src/lib/manager-property-quota.server.ts`) runs on every
  `POST /api/property-records` upsert AND in the two assistant write tools that
  put a record into a slot without passing through that route —
  `create_property` (inserts `pending`) and `update_property` (sets `live`).
  Otherwise a manager at their cap could ask the agent for the listing the
  portal's disabled "+ Add property" and its Relist button both refuse. The
  other tool-layer writers of `manager_property_records` are deliberately
  ungated and say so in a comment: `copy_listing_photos`,
  `update_property_lease_config` and `apply_listing_photos` patch only
  `row_data`/`property_data`, and `upsertManagerListingDraft` always writes
  `draft`. Any NEW writer that can move a record into a listing slot needs the
  same call. The client checks are courtesy
  pre-checks so a manager hears it before their photos upload; every layer
  prints the same sentence from `managerPropertyLimitMessage`, and the route's
  403 body (`MANAGER_PROPERTY_LIMIT_ERROR_CODE`) travels back through
  `upsertPropertyRecordToServer`'s `onError(message, code)` into the wizard
  toast — a refusal must never degrade to "Could not submit listing."
  The property-record outbox (`src/lib/property-record-outbox.ts`, which
  replaced the page-load portfolio re-upload) flushes unsent writes
  SEQUENTIALLY for the same reason: fired concurrently, N creates each read the
  slot count before any of them lands, so the cap would be racy. A refused
  write is settled, never replayed, and dispatched as
  `PROPERTY_RECORD_REFUSED_EVENT`; `ManagerProperties` toasts it only when the
  `code` is the plan refusal, once per distinct message. It keys on the `code`,
  never on "the body had an error": it is background work the manager never
  initiated, so a 500's raw Postgres text stays silent (and the write stays
  queued). Only a caller the manager is waiting on — the wizard — shows the
  server's message verbatim.
- **It gates the TRANSITION INTO a listing slot, never the state of being over
  the cap.** `LISTING_SLOT_PROPERTY_STATUSES` (`persisted-property-records.ts`)
  is `pending`/`live`/`review` — derived from `propertyRowsToSnapshot`, which is
  what the portal itself counts, so drafts and unlisted rows are free. A row
  already in a slot is never re-charged, which is what lets a seeded or
  downgraded over-limit portfolio keep editing, unlisting, relisting-in-place
  and deleting. **Block creation; never delete or hide a manager's records.** A
  failed slot count — or a plan that cannot be read — is a 500, never "zero
  used" and never the Free cap.
- **Relist transitions ONE record in place, and must never pair its upsert with
  a delete of the same id.** Every unlisted row comes from
  `unlistManagerListing` via `mockToAdminRow(removed, listingId)`, so
  `adminRefId === listingId` and the upsert `listAdminRow` mirrors already
  carries that id. `listAdminRow` used to follow it with a fire-and-forget
  `deleteMirroredPropertyRecord` at that same id, which only looked harmless
  while every upsert was accepted and the next mirror re-created the row. A
  refusal the viewer-scoped client pre-check cannot predict — an owner at their
  cap behind a co-managed listing, or a plan the server could not read — would
  otherwise let the delete land alone and take
  `clearHousingAccessForDeletedProperty` with it. Coverage:
  `tests/unit/manager-relist-in-place.test.ts`.
- **Section entitlements are a separate, page-level gate** and deliberately
  unchanged here: `managerSectionAllowedForTier` + `subscriptionGated` in
  `render-portal-section.tsx` paywall Residents/Leases/Services for a
  committed Free plan (Communication is in `FREE_SUBSCRIPTION_SECTIONS` — every
  plan gets the inbox and a work number, see [comms-billing.md](comms-billing.md)),
  but an account with NO `manager_purchases` row still resolves to `null` in
  `getManagerSubscriptionTier` (legacy full access). Locking those sections
  would make existing records unreachable, so it is a product decision, not a
  bug to quietly fix. Their API routes are also ungated — a free manager can
  still read/write residents and leases over HTTP. Known gap, deliberately not
  closed alongside the property cap.
- Coverage: `tests/unit/manager-effective-plan-tier.test.ts`,
  `property-records-plan-property-limit.test.ts`,
  `property-listing-slot-statuses.test.ts`,
  `manager-listing-publish-limit-feedback.test.ts`,
  `manager-subscription-tier-client.test.ts`,
  `manager-subscription-route-unknown-plan.test.ts`,
  `manager-relist-in-place.test.ts`,
  `manager-trial-expiry-quota.test.ts`,
  `tools/property-resident-writes.test.ts`.

## Communication credit and processing fees

The tiers differ on TWO axes: what a plan unlocks (properties, co-managers,
sections — above) and how much texting, calling and assistant use is included
each month. The second axis is owned by [comms-billing.md](comms-billing.md):
every plan includes Communication and a work number; the monthly retail credit
per plan is `COMMS_INCLUDED_ALLOWANCE_CENTS` (`src/lib/comms-billing/allowances.ts`),
manual top-ups carry forward, and a saved card never authorizes an automatic
charge. Quotas read only the effective SKU (`getEffectiveManagerSkuTier`).
Customer-facing copy (pricing cards and FAQ, `src/data/manager-plan-tiers.ts`
and `src/app/(public)/pricing/page.tsx`) is DERIVED from that constant through
`commsAllowanceFeatureText`, so the page cannot promise a number the code does
not enforce. Coverage: `tests/unit/plan-comms-allowance-copy.test.ts`.

No subscription grants payment-processing coverage; only the staff-owned
account override does — [resident-payments.md](resident-payments.md).

## Settings → Billing & plan page shape

`src/components/portal/pro-plan.tsx` (`ManagerPlan`) owns the whole page, in
this order: Plan (one resolved `effectiveTier`, no pill, a scheduled-change
banner with Undo when one is pending) → Extra usage / Messaging credit
(`ManagerExtraUsagePanel` when `COMMS_CREDIT_POOL_ENABLED` is off — typed-dollar
credit purchase via `use-credit-checkout.ts`, alert threshold, usage rates —
or `MessagingCreditPanel` when it is on, see
[comms-billing.md § messaging-credit pool](comms-billing.md)) → Add-ons
(`ManagerPlanAddonsPanel`, mounted, not re-implemented) → Payment
(`ManagerPaymentMethodsPanel`) → Invoices (`GET /api/manager/invoices`) →
Cancellation. The three plan cards from the pre-PLAN-0920-1400 page live
behind the **Adjust plan** sheet (`pro-plan-adjust-sheet.tsx`), never inline.
The Usage and Residents sections (`ManagerUsagePanel`, `ManagerDoorsPanel` in
`manager-usage-panel.tsx`) were removed from this page (S27) — the components
still exist for any other caller, they are simply no longer mounted here.

Every tier read on the page goes through one resolved `effectiveTier`
(`resolveEffectiveManagerSkuTier`) — the header, Usage's plan label and the
Adjust sheet's "Current" tag all read the same value, never a second
`tier`/`isBusiness` check that could disagree with it.

**A plan change never applies immediately unless it is a same-tier
Monthly→Annual switch** (proration, effective today — Stripe's own
`useProration` branch in `POST /api/stripe/subscription/update-tier`).
Annual→Monthly and any tier downgrade (Business→Pro) are scheduled at the
current period's end via that same route's `scheduledDowngrade` metadata
plumbing (`META_SCHEDULED_TIER`/`META_SCHEDULED_BILLING` on the Stripe
subscription) and reported back by `GET /api/manager/subscription` as
`scheduledDowngrade`; `action: "cancel_downgrade"` on the same route is Undo.
The Adjust sheet reuses this existing plumbing rather than inventing a second
scheduling mechanism.

A no-card signup trial (`billing: trial`, Pro or Business entitlement, no
Stripe/Apple subscription) is not an existing paid plan. Billing & plan lets
that manager select the same tier and monthly cadence and start an embedded
paid checkout. The route reserves the owned Checkout session on the existing
trial purchase row without changing its tier or trial billing first; only
verified paid fulfillment replaces those terms. Concurrent starts keep one
reserved session and expire the losing new session. An existing paid Stripe or
Apple subscription is never offered a second subscription checkout, and a
failed purchase read cannot be treated as Free. Coverage:
`tests/unit/manager-trial-portal-checkout.test.ts`,
`tests/unit/pro-plan-adjust-sheet-doors.test.tsx`.

## Workspaces, work numbers and seats

`WORKSPACE_PLAN_ENTITLEMENTS` (`src/lib/workspaces/types.ts`) is the third axis:
Free 1 workspace, Pro 1, **Business 2** (PLAN-0920; previously 3).
`loadWorkspacePlan` (`src/lib/workspaces/server.ts`) never strands an existing
account below what it already owns — `workspaceLimit` is
`max(plan cap + purchased extra_workspace, the account's current owned
workspace count)`, so a Business account already holding 3 keeps all 3 and can
still edit, add houses to, and manage every one of them; it just cannot open a
4th without the add-on. `includedWorkNumbers(tier, workspaceCount)`
(`src/lib/plan-addons.ts`) is Pro 1 regardless of workspace count, Business one
per workspace, Free none; every workspace holds at most 2 numbers
(`maxWorkNumbersForWorkspaces`). See [comms-billing.md § Add-ons](comms-billing.md)
for the extra-workspace, extra-work-number and extra-seat add-ons and how
`ensureAddonPrice` keeps every add-on always purchasable.

## Admin Billing (staff view + per-account overrides)

There is no `/admin/billing` page (it 404s on purpose; see the end of this
section). What used to be that lens is now two things: **Accounts > Subscribers**
(`/admin/subscribers`, below) for who is paid, on a trial, on a promo code, free
or complimentary, and the account record's Billing section for one account's
plan and overrides. What PropLane itself EARNS is a third, separate thing:
**Money > Payments** (below). The row derivation described next
(`deriveAdminBillingRow`) is shared by all of them.

The original Billing list was a LENS on the accounts already in `/admin/axis-users`,
not a second place to administer one. It was the same `PortalRecordListSurface` +
`PortalPersonRecordRow` every other list tab uses, and opening a row opens the
SAME editor Accounts opens — `ManagerAccountDetail`
(`src/components/portal/admin-manager-account-detail.tsx`), which both clients
import. A plan change made from Billing and one made from Accounts must be the
same control, or the two grow different rules for the same write.

**Every number on that screen comes from the resolver enforcement uses.** The
list route (`GET /api/admin/manager-billing`) reads in chunked bulk queries
regardless of how many accounts exist, and `deriveAdminBillingRow`
(`src/lib/admin-billing-rows.ts`) turns each account into a row through
`resolveEffectiveManagerSkuTier`, `maxPropertiesForManagerTier`, the same
`LISTING_SLOT_PROPERTY_STATUSES` the quota counts, `resolveServiceFeePayerFor`,
and the prepaid wallet snapshot the dispatcher spends from
(`loadCommsWalletTotals` — [comms-billing.md](comms-billing.md)). A staff screen
that computed any of them a second way would eventually disagree with what the
manager is actually charged or refused, which is the whole failure this list
exists to make visible.

**`planUnknown` is the state that file is most careful about.** A purchase chunk
that fails to read marks only the managers in THAT chunk as `planReadFailed`;
the row then prints "Plan unknown" and prints NOTHING derived from it (no cap,
no fee payer, no allowance) rather than the Free defaults those resolvers would
produce from zero rows. Such a row appears under **All** and no other tab —
filing it under Free would be the one wrong guess that matters, and a sixth
"unknown" tab would bury it. Tabs are All / Trial / Free / Pro / Business /
Absorbing fees, and `absorbing` reports the NET answer, so a paid account that
has made no choice of its own counts (the paid-plan default in
`resolveServiceFeePayerFor` IS `proplane`).

### Per-account overrides

`PATCH /api/admin/manager-billing-overrides` is the staff-only writer:
service-role write after an admin check on every request, exactly like
`/api/admin/manager-service-fee`. `saveManagerBillingOverrides` does no
authorization of its own - matching every other service-role writer here - so
that route is the boundary; a manager who could set their own property cap would
have no cap. Storage is `manager_automation_settings.row_data.billingOverrides`
(`src/lib/manager-billing-overrides.ts`). **No migration was needed**: `row_data`
exists in every deployment of that table, and every other writer of it
read-modify-writes its own key.

- **`propertyCap`** - read by enforcement. It replaces the plan cap in
  both directions inside `assertManagerPropertyListingQuota`, and `0` is a real
  value ("may not publish"), which is why it is `null`-for-absent rather than
  falsy-for-absent. A pinned cap gets its own refusal copy
  (`managerPropertyCapOverrideMessage`) with no upgrade CTA - upgrading would not
  move a number a staff member typed. **A cap that cannot be READ is a 500**,
  exactly like a plan that cannot be read: falling back to the plan default would
  refuse a manager staff had explicitly comped a bigger cap, on a transient
  database error. It still only ever gates the TRANSITION INTO a slot, so
  lowering a cap below what an account already holds refuses the next listing and
  touches nothing that exists - block creation, never delete or hide. The reason
  is optional here (the account record's popup asks for one anyway).
- **Trial end, complimentary and promo code are LIVE** (they were "recorded only"
  until 2026-10-08; a control that does nothing is worse than none). They act
  through `src/lib/admin/admin-billing-actions.server.ts`, never by writing a
  second value for a reader to forget:
  - **Extend trial** (`trialEndsAt`, a future `YYYY-MM-DD`, at most two years out).
    With a Stripe subscription it sets the subscription's `trial_end`
    (`proration_behavior: none`; Stripe moves the billing anchor). A no-card
    signup trial has **no stored end** - `resolveEffectiveManagerSkuTier` derives
    it as `paid_at + MANAGER_SUBSCRIPTION_TRIAL_DAYS` and every plan reader (the
    property cap, nav locks, comms allowance, the admin lists) goes through that
    one derivation - so extending it writes the `paid_at` that produces the asked
    end (`paidAtForSignupTrialEnd`, the inverse kept beside the derivation in
    `manager-tier-expiry.ts`). The resolver itself is unchanged and every reader
    honours the new date at once. The trial is live through the whole of the
    chosen UTC day. A row that is neither a Stripe subscription nor a signup trial
    has no trial to extend (409). A date older builds merely recorded is cleared.
  - **Complimentary** (`complimentary`, true/false). With a Stripe subscription it
    attaches the one 100%-off-forever coupon `proplane_complimentary` (created on
    first use) beside any discounts already there, so the next invoice is $0; off
    detaches only that discount. Without a subscription nothing bills, but access
    can still lapse (a trial expires by date), so the purchase becomes an
    admin-assigned plan (`billing: admin`) that never expires, and the prior
    `billing`/`paid_at` are kept in `billingOverrides.complimentaryPrior` so Undo
    restores them (a trial that has since lapsed is Free again, which is the
    point of undoing). A Free account or an App Store subscription is refused:
    there is nothing PropLane can waive.
  - **Apply promo code** (`promoCode`). Attaches an EXISTING Stripe promotion code
    to the subscription (never creates one - that is the Promo codes page), keeping
    the discounts already there; an unknown/inactive code is a 404, a code already
    applied a 409, and an account without a Stripe subscription a 409. It does not
    write `manager_purchases.promo_code`, because a non-empty value there is the
    waiver signal `isWaiverGrantedManagerPurchase` reads as paid access.
  - **Every one requires a reason**, refused (400) before the cap in the same
    request, Stripe or any write is touched, and writes exactly one `audit_log` row
    (below). Stripe failures are logged and reported as one generic sentence; a
    dedicated test workspace never reaches Stripe.
- **Save plan** (`PATCH /api/admin/managers`, `tier`) now requires a reason too
  and writes one audit row (`field: plan`, before -> after, from the purchase row
  the resolver reads, Free when there is none). It is still an admin assignment
  (`billing: admin`, which clears `stripe_subscription_id`): it does not edit the
  Stripe subscription, so use it for accounts not billed through Stripe.

Every accepted change writes one `audit_log` row PER FIELD THAT ACTUALLY MOVED
(`writeAdminBillingAudit`, `src/lib/admin-billing-audit.server.ts`):
`actor_user_id` is the staff member, `landlord_id` the manager, and
`input_summary` carries `field`, `before`, `after` and the `reason`. The
value alone never says who granted the exception or why. `reason` is the one
deliberate departure from the agent audit convention's ids-and-enums rule - it is
staff-authored text about a commercial decision, not lifted from a resident - and
it is trimmed to 280 characters. `dedupe_key` is left unset on purpose: setting
the same cap twice is two real decisions. A no-op (already complimentary, the cap
unchanged) writes nothing.

### The account record's Billing & plan section

`/admin/axis-users/<id>?section=billing` (`AccountBillingSection`,
`admin-account-record-sections.tsx`) is three fact cards plus a list, fed by one
read - `GET /api/admin/accounts/[id]/billing`
(`src/lib/admin/admin-account-billing.server.ts`):

- **Subscription**: Plan (`Pro monthly`), Source (Stripe / App Store / Admin /
  Promo code / Trial / None), Status, Since, Renews (or Ends, when set to cancel),
  Paid to date, Promo. Icon actions top right: Open in Stripe, Change plan.
- **Trial & discounts**: Trial ends, Complimentary, Promo. Icon actions: Extend
  trial, Apply promo code, Make/Remove complimentary.
- **Limits**: Property cap (stepper; its check icon saves it) and Processing fees
  (dropdown, save on change, with the net "Fees paid by").
- **Payments from this account**: the customer's paid Stripe invoices, newest
  first, each opening its hosted invoice.

The plan, and the property cap, come from the SAME resolvers enforcement uses. The
subscription facts, promo code and complimentary state are read from Stripe when
there is a subscription (the subscription is the truth), otherwise from the
purchase row and the staff record. "Paid to date" and the payments list are paid,
non-zero invoices for this account's own `stripe_customer_id`, read server-side;
refunds are not netted. **If Stripe cannot be reached the database facts still
render, `stripe.available` is `false`, and the Stripe-derived numbers are `null`
("-"), never `0`.** There is no grey block over the values and no sentence under a
field (the no-subtext rule); Change plan / Extend trial / Apply promo code / Make
complimentary / the cap each open a small standard popup with a required one-line
Reason and one primary that names the outcome (`AdminBillingActionDialog`).

**One global default now exists (S27):** the Plan credit table
(`PlanCreditRulesSection`, `src/components/portal/admin-billing-client.tsx`)
sets each plan's included messaging credit, whether it is shared across a
funder's workspaces, and whether unused credit rolls over
(`comms_plan_credit_rules`, seeded from `RATE_CARD`) — see
[comms-billing.md § messaging-credit pool](comms-billing.md). It only takes
effect through that pool (`COMMS_CREDIT_POOL_ENABLED`, off by default); every
other plan-wide figure (doors, floor price, residents) is still hand-typed in
`RATE_CARD` and not yet admin-editable.

It landed pointed at `/admin/billing`, but `"billing"` was never registered in
`adminPortal.sections` (`src/lib/portals/admin.ts`), so that URL 404s — the
table was reachable in code review, never in the product. It now mounts from
Accounts (`/admin/axis-users`) behind the header "Plan credit" icon action
(`AdminAxisUsersClient`), which opens it in a modal; there is no separate
`/admin/billing` route.

Coverage: `tests/unit/admin-billing-rows.test.ts`,
`admin-manager-billing-overrides-route.test.ts`,
`admin-billing-actions.test.ts` (Stripe mocked: trial extension, complimentary on
and off, promo attach, audit rows, reason required),
`admin-account-billing-route.test.ts`, `admin-managers-plan-change-route.test.ts`,
`manager-trial-expiry-quota.test.ts` (an extended trial through the real
resolver), `manager-property-cap-override.test.ts`, plus
`admin-list-surface-adoption.test.ts` and `platform-parity.test.ts` for the
section wiring.

## Admin Subscribers (Accounts > Subscribers)

`/admin/subscribers` lists every real (non-sandbox) manager in exactly one of
**Paid · Trial · Promo · Free · Complimentary**, with counts on the tabs.
`classifySubscriber` (`src/lib/admin/admin-subscribers-model.ts`) runs
`deriveAdminBillingRow`, so the bucket is the plan the product ENFORCES, not a
second opinion: a lapsed signup trial is **Free**, a live Stripe or Apple grant
is **Paid**, and an account whose purchase could not be read is counted
nowhere (never filed as Free). Order, first match wins: Complimentary (the
staff `complimentary` override, or a `billing: admin|portal` / `admin_` grant
with no payment behind it) → Trial (`billing: trial`, unexpired) → Promo (paid
plan + `stripe_promotion_code`, or a `promo_code` waiver) → Paid → Free. A Stripe subscription still inside its
Checkout trial days is **Paid** here because that is what enforcement says; the
Trial tab is the no-card signup trial. MRR is the sum of the Paid bucket at
list price (`RATE_CARD` base plan, annual / 12; per-door overage is not
included).

`GET /api/admin/subscribers` reads through paged selects
(`readAllPages`, stable order, a failed page throws) and id-chunked profile
reads, never an unbounded select, then pages the answer. Stripe's period end
("Renews Nov 12") is looked up for the visible page only and a miss leaves the
fact out. The trial end shown honours the staff `trialEndsAt` override; a trial
inside its last three days draws amber text, never a pill. The row ⋯ opens the
account, and deep-links to the account record's billing section with
`?action=promo` / `?action=extend-trial` (the popups live on that record).

## Admin Money > Payments

`/admin/payments` is a live read of PropLane's platform Stripe account
(`src/lib/admin/admin-revenue.server.ts`, `GET /api/admin/revenue`), cached five
minutes per month. Balance transactions are classified by
`classifyBalanceTransaction` (`admin-revenue-model.ts`): checkout `purpose`
metadata (`COMMS_CREDIT_PURPOSE`, the number purposes) → Credits / Numbers; a
charge on a subscription invoice (price ids via `stripe-price-ids.ts`) or from a
customer holding a PropLane subscription → Subscriptions; the vendor 3% fee
comes from `platform_revenue_entries` (it is held back from a vendor payment,
so it is never its own Stripe transaction) → Service fees; payouts; refunds of
PropLane revenue. **The platform account also carries pass-through money (rent,
vendor payments): anything not attributable to a PropLane product is `other`,
listed under All and never added to gross, fees or refunds.** Rows link to the
account through `manager_purchases.stripe_customer_id`, the comms billing
account, or `manager_user_id` metadata. App Store rows are
`manager_purchases` Apple grants (production environment only), shown "via App
Store"; Apple's commission is not in our data, so they carry no fee.

Stat strip: Gross (earning categories) · Stripe fees · Net (gross − refunds −
fees) · Refunds · Next payout. The Dashboard's **Earned this month** is gross −
refunds; **Profit** is earned − Stripe fees − that month's `platform_expenses`.
A Stripe failure, a missing `platform_expenses` table or an unreadable
population is `null` and the Dashboard card is **omitted, never $0**
(`buildAdminMoneyOverview`). A test-mode key (`sk_test_`) shows the banner. A
month past 1,500 balance transactions is flagged `truncated` on the page.

Coverage: `tests/unit/admin-revenue.test.ts`, `admin-subscribers.test.ts`,
`admin-portal-sections.test.ts`.
