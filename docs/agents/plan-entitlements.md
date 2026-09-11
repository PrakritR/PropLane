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
  admin / portal grants have their own authorization rules. Omitting `billing`
  and `paidAt` keeps the older behaviour for a caller with no billing row to
  read. Coverage: `tests/unit/manager-trial-expiry-quota.test.ts`.
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
  `mirrorLocalPropertyPipelineToServer` sends its writes SEQUENTIALLY for the
  same reason: fired concurrently, N creates each read the slot count before any
  of them lands, so the cap would be racy on the path most likely to send
  several at once. It reports the first refusal once per run, never per row —
  and it has exactly ONE owner (`ManagerProperties`; the properties panel it
  renders deliberately does not mirror, or every load doubled the writes and
  toasted twice). The mirror keys on the `code`, never on "the body had an
  error": it is background work the manager never initiated, so a 500's raw
  Postgres text stays silent. Only a caller the manager is waiting on — the
  wizard — shows the server's message verbatim.
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

## Admin Billing (staff view + per-account overrides)

`/admin/billing` is a LENS on the accounts already in `/admin/axis-users`, not a
second place to administer one. It is the same `PortalRecordListSurface` +
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
authorization of its own — matching every other service-role writer here — so
that route is the boundary; a manager who could set their own property cap would
have no cap. Three fields, stored at
`manager_automation_settings.row_data.billingOverrides`
(`src/lib/manager-billing-overrides.ts`). **No migration was needed**: `row_data`
exists in every deployment of that table, and every other writer of it
read-modify-writes its own key.

- **`propertyCap`** — the only one enforcement READS. It replaces the plan cap in
  both directions inside `assertManagerPropertyListingQuota`, and `0` is a real
  value ("may not publish"), which is why it is `null`-for-absent rather than
  falsy-for-absent. A pinned cap gets its own refusal copy
  (`managerPropertyCapOverrideMessage`) with no upgrade CTA — upgrading would not
  move a number a staff member typed. **A cap that cannot be READ is a 500**,
  exactly like a plan that cannot be read: falling back to the plan default would
  refuse a manager staff had explicitly comped a bigger cap, on a transient
  database error. It still only ever gates the TRANSITION INTO a slot, so
  lowering a cap below what an account already holds refuses the next listing and
  touches nothing that exists — block creation, never delete or hide.
- **`trialEndsAt`** — RECORDED AND DISPLAYED ONLY. The plan resolver still expires
  a signup trial by `paid_at + MANAGER_SUBSCRIPTION_TRIAL_DAYS`; nothing reads
  this. The admin control says so under the field.
- **`complimentary`** — RECORDED AND DISPLAYED ONLY. Billing does not read it yet.
  A comp switch that silently stopped invoicing would be a money change made in a
  UI ticket; the control says so under the field.

Every accepted change writes one `audit_log` row PER FIELD THAT ACTUALLY MOVED
(`writeAdminBillingAudit`, `src/lib/admin-billing-audit.server.ts`):
`actor_user_id` is the staff member, `landlord_id` the manager, and
`input_summary` carries `field`, `before`, `after` and the optional `reason`. The
value alone never says who granted the exception or why. `reason` is the one
deliberate departure from the agent audit convention's ids-and-enums rule — it is
staff-authored text about a commercial decision, not lifted from a resident — and
it is trimmed to 280 characters. `dedupe_key` is left unset on purpose: setting
the same cap twice is two real decisions.

Not yet built (a separate ticket): **global defaults** — changing what a plan
includes for everyone, rather than excepting one account.

Coverage: `tests/unit/admin-billing-rows.test.ts`,
`admin-manager-billing-overrides-route.test.ts`,
`manager-property-cap-override.test.ts`, plus
`admin-list-surface-adoption.test.ts` and `platform-parity.test.ts` for the
section wiring.
