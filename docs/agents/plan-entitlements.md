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
  `ok: false`. **That rule has to reach BOTH halves or it is worse than not
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
  `render-portal-section.tsx` paywall Residents/Leases/Services/Communication
  for a committed Free plan, but an account with NO `manager_purchases` row
  still resolves to `null` in `getManagerSubscriptionTier` (legacy full access).
  Locking those sections would make existing records unreachable, so it is a
  product decision, not a bug to quietly fix. Their API routes are also ungated
  — a free manager can still read/write residents, leases and inbox rows over
  HTTP. Known gap, deliberately not closed alongside the property cap.
- **The manager portal's NAV tier is not the billing tier.**
  `getManagerPortalNavSubscriptionTier` (`manager-access-server.ts`) is the tier
  `getProPortalRenderContext` resolves, so it feeds the `pro` portal's sidebar
  locks and the `managerTierPaywall` that `renderPortalSection` applies to a
  `pro` section. A manager who owns at least one property keeps their own plan,
  but a *pure* co-manager (no owned property, ≥1 accepted
  `account_link_invites` row) inherits the best tier among their inviters via
  `pickManagerPortalNavSubscriptionTier`, ranked
  `paid` > `null` (legacy full access) > `free`. Without it a Free-tier linked
  account was padlocked out of the Pro modules its owner pays for. It is for
  sidebar and section rendering ONLY — billing UI, quotas and every
  `resolveEffectiveManagerSkuTier` caller still read the account's own plan, so
  do not substitute it there. Coverage:
  `tests/unit/manager-portal-nav-tier.test.ts`; the nav side of co-manager
  scoping is in [`co-manager-access.md`](co-manager-access.md).
- Coverage: `tests/unit/manager-effective-plan-tier.test.ts`,
  `property-records-plan-property-limit.test.ts`,
  `property-listing-slot-statuses.test.ts`,
  `manager-listing-publish-limit-feedback.test.ts`,
  `manager-subscription-tier-client.test.ts`,
  `manager-subscription-route-unknown-plan.test.ts`,
  `manager-relist-in-place.test.ts`,
  `tools/property-resident-writes.test.ts`.
