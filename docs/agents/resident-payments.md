> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Resident payments: who pays the service fee depends on the manager's plan + clearing-window `processing` status

**No subscription includes processing-fee coverage** (captain decision September 10, 2026).
All plans default to resident pays. Pro and Business managers may choose to absorb
the fee through their payout. **PropLane covers it with a promo code** (captain
decision September 12, 2026, reversing the staff-only rule of September 10): the
account's own `manager_purchases.promo_code` grant (written only by server flows
that validated it — signup FREE100, onboard comp), or the listing's own
`serviceFeeWaiverCode` typed on the Pricing step when "PropLane pays" is chosen.
Staff can still approve any account outright through
`adminServiceFeeOverride: "proplane"`.

A paid plan alone, or a legacy `proplane` selection with nothing backing it, does
not grant coverage; it reads as `resident`. The promo code itself is never printed
in product copy — fields ask for it, they do not show it. Application-fee waivers
remain separate. Subscription GET exposes `paymentWaiverGranted` = staff override OR
account promo grant; a failed read is unknown and disables coverage selection.
Manager settings and staff overrides use separate atomic RPCs on the same row, so a
manager save cannot overwrite a concurrent staff revocation. Unknown plan reads stop
checkout before deciding who pays.

**Two paths, one fee math.** Ready Connect + bank
(`connectAccountReadyForAchPayouts`: transfers active AND `payouts_enabled`)
is a destination charge on the PLATFORM account
(`transfer_data.destination = <that person's connected account>`, **never** a
direct charge / `on_behalf_of` / a `Stripe-Account` header). No bank yet: the
same checkout still completes as a platform charge (`platform_hold=1`); the
webhook credits `platform_payment_holds` and `account.updated` transfers the
leftover when they become ready. Withdraw never spends a hold. Only who
bears the fee moves, via `application_fee_amount` on the destination path
(omitted on the hold path):

| Fee payer | Resident charged | `application_fee_amount` | Manager receives | PropLane net |
| --- | --- | --- | --- | --- |
| resident (Free, or an explicit paid-plan choice) | subtotal + fee | fee | subtotal | ≈ 0 |
| manager (explicit paid-plan choice) | subtotal | fee | subtotal − fee | ≈ 0 |
| proplane (promo grant — account or listing code — or staff approval) | subtotal | omitted | subtotal | − Stripe's fee |

`src/lib/payment-policy.ts` is the single source of truth:
- `residentProcessingFeeCents(subtotal, method)` — Stripe's cost (ACH 0.8% cap
  $5; card/Link 2.9% + $0.30). A pass-through, never a markup.
- `resolveServiceFeePayer(tier, proChoice)` — the plan rule above. `tier` is the
  normalized SKU tier (`normalizeManagerSkuTier(...) ?? "free"`), so a
  legacy/unknown tier resolves to `resident`.
- `resolveServiceFeePayerFor({ tier, adminOverride, propertyChoice, managerChoice, waiverGranted })`
  — the ONE resolver the money paths call. Precedence, most specific first:
  **staff override → the property's own Pricing setting → the manager's account
  default → resident**. Steps 2-4 stay subject to the plan rule above;
  the staff override deliberately ignores it, because staff absorbing a
  free-tier manager's fees is the whole point of that control. `waiverGranted`
  is the server-validated promo grant
  (`resolveAccountOrListingWaiverGranted(accountPromoCode, listingWaiverCode)`);
  a `proplane` choice resolves to `proplane` only with it, otherwise to
  `resident` on every tier. It unlocks `proplane` only — it does not turn Free
  into a paid plan for the `manager` choice.
  `managerCanSelectProplaneServiceFee(tier, granted)` /
  `managerCanSelectManagerAbsorbServiceFee(tier)` are the same rule for the
  Payment setup UI, so what the modal offers cannot drift from what checkout
  honours.
- `residentServiceFeeBreakdown(subtotal, method, feePayer)` — how the fee lands
  (resident total, retained `application_fee_amount`, manager payout). The
  checkout builder and every disclosure derive from this, holding the invariant
  `totalCents − applicationFeeCents === managerPayoutCents` in all three cases;
  `createAxisAchCheckoutSession` throws before creating the session if it ever
  fails, and adds the resident fee line item ONLY when the resident pays.

The **manager choice** is `serviceFeePayer: "resident" | "manager" | "proplane"` on
`ManagerManualPaymentSettings` (default `resident`), edited in the manager
Payment setup modal (Pro and Business) and read live at charge time in
`stripe-household-charge-checkout.server.ts` — a plan change or toggle flip takes
effect on the next charge with no per-charge state. A resident learns their
manager's fee-payer for pre-checkout disclosure via
`GET /api/portal/resident-service-fee`
(`getManagerServiceFeePayerByManagerId`, scoped to their own
`profiles.manager_id`). That read runs the SAME `resolveServiceFeePayerFor`
precedence the money paths do, so the payer a resident is shown before checkout
cannot disagree with the one they are billed under; it resolves without a
`propertyChoice` because the account-wide disclosure has no property in hand.

**Choosing `proplane` for the ACCOUNT requires a promo grant or the staff
override**, because it spends PropLane's own money. `resolveSavedServiceFeeSelection`
(`manager-manual-payment-settings.ts`) is the one decision: a valid typed code keeps
`proplane` and stores the normalized code; an account grant (promo or staff) keeps
it without one; an account already on `proplane` carries it forward on an unrelated
re-save; anything else resolves to `resident`, exactly as
`persistListingServiceFeePayer` does per listing. `PATCH
/api/portal/manager-manual-payment-settings` looks the grant up server-side
(`accountWaiverGranted`: staff override, else `getManagerPurchaseSku().promoCode`)
and REFUSES an unbacked selection with **400** rather than storing the downgrade and
answering 200. The save itself goes through the `save_manager_payment_preferences`
RPC (`20260912120000_payment_preferences_promo_coverage.sql`), which locks the
settings row, drops any caller-supplied override, re-applies the stored one, and
downgrades `proplane` to `resident` unless the server passed `p_coverage_granted`
or the stored override approves it — so a manager save that overlaps a staff
revocation can never restore the approval, and the grant answer is never taken from
the client. **The Payment setup modal applies `proplane` for a WORKSPACE only by a
code at the moment it is chosen** (captain, 2026-09-14): "PropLane pays" is always
in the select, picking it saves nothing and opens the coverage-code field, and the
route refuses `workspaceServiceFeePayer: "proplane"` with **400** unless
`workspaceServiceFeeWaiverCode` matches the server-only list (the staff override
is the one thing that still needs no code). A grant already on the account never
flips a workspace on by itself. The matched code is kept with the workspace
(`portal_workspaces.payment_settings.serviceFeeWaiverCode`) and counts toward
`waiverGranted` at both checkouts — next to the account grant and a listing's own
code — and is never echoed back in `workspacePaymentSettings`. Per-property
choices saved from Payment settings are written onto each listing by
`applyPropertyServiceFeePayersToListings` through that same helper, so the grant
must be forwarded into that pass or an approved `proplane` choice downgrades to
`resident` on the listing. Coverage:
`tests/unit/manager-service-fee-waiver-code.test.tsx`,
`tests/unit/evidence-manual-payment-settings-route-waiver.test.ts`,
`tests/unit/service-fee-payer-precedence.test.ts`,
`tests/unit/manual-payment-settings-property-fee-payer-propagation.test.ts`.

The **property choice** is `serviceFeePayer` on `ManagerListingSubmissionV1`,
edited in the listing wizard's Pricing step. `null` means "follow the account",
which is NOT the same as any of the three payers — an untouched property must
keep tracking the account default rather than being frozen at whatever it was
when the property was created. One checkout session bills one total, so
`createHouseholdChargeCheckout` REFUSES a batch spanning properties that disagree
(422 `MIXED_SERVICE_FEE_PAYERS`) rather than picking one; either choice would
silently change what the resident is charged.

The **staff override** is `adminServiceFeeOverride` on the same
`ManagerManualPaymentSettings` row, but it is not the manager's to write:
`saveManagerManualPaymentSettings` (which the manager's own settings route calls)
drops whatever the caller supplied and the RPC restores the stored value, and staff
write it through `saveAdminServiceFeeOverride` (`set_staff_payment_fee_override`
RPC, same row lock) behind `GET/PATCH /api/admin/manager-service-fee`, which is
where the admin check lives. `null`
CLEARS the override back to the plan-and-choice rule; pinning `resident` is a
different act that fixes the answer whatever the manager later chooses.
Application-fee checkout reads the override and the account default (there is no
per-property application fee). Coverage:
`tests/unit/service-fee-payer-precedence.test.ts`,
`tests/unit/property-service-fee-payer.test.ts`,
`tests/unit/admin-service-fee-override-ownership.test.ts`,
`tests/unit/admin-manager-service-fee-route.test.ts`.

**Every staff change to the override is audited** (PRP-277). The override is
staff spending PropLane's money, so `PATCH /api/admin/manager-service-fee`
writes one `audit_log` row per successful save through
`recordAdminServiceFeeOverrideChange` (`src/lib/admin-service-fee-audit.server.ts`):
`actor_user_id` is the staff member, `landlord_id` the manager,
`action = "admin_service_fee_override"`, `input_summary` carries
`previousOverride` / `newOverride` (`null` = no override) and the optional
staff-entered `reason` (trimmed, capped at 240 chars — the only free text on
the row, and never resident or applicant input), and `result_summary` carries
`effectiveBefore` / `effectiveAfter` from `resolveServiceFeePayerFor`, so the
trail says whether the change actually moved the bill (pinning `manager` on a
Free plan changes nothing until the plan does). The row is written AFTER the
override save, and a failed write is a 500 — the admin screen re-reads the
server on any error rather than restoring its previous selection, because the
override may already be applied. `GET` (and the write response) return the
last ten as `changes`, newest first, with the actor's email resolved from
`profiles` (`null` once that staff profile is gone); the Accounts screen
renders them as a "Changes" list under the dropdown beside the reason field
and the launch-default help text. No new table: `audit_log` is service-role
only and already classified in the purge manifest — the trail is keyed on the
MANAGER, so it goes with the manager's account (`landlord_id` in `ids`) while a
deleted staff member only has `actor_user_id` detached.

**The rental application fee follows the SAME plan-based rule** (captain
decision, 2026-07-26, superseding the earlier "out of scope, always face
value" carve-out): `/api/stripe/application-fee-checkout`
(`src/lib/application-fee-checkout.server.ts`) resolves `feePayer` from
`resolveServiceFeePayerFor` + the manager's `loadManagerManualPaymentSettings`,
exactly like a household charge — Free applicants pay the fee, Pro and Business
follow the manager's resident/manager choice, and PropLane absorbs it only under
the staff override. A plan that cannot be read stops checkout instead of
defaulting a payer. The listing page itself
still shows only the application fee (no plan tier leaks there); the itemized
service fee only appears once an applicant reaches the payment step
(`/api/public/application-fee-preview` returns the same breakdown the checkout
route will charge, so the wizard itemizes it before the applicant pays).
**Payment is INLINE (embedded), not a redirect** — `application-fee-checkout`
defaults to `mode: "embedded"` and returns a `clientSecret`; the wizard renders
Stripe's embedded card form in-step (`ApplicationFeeInlinePayment` →
`StripeEmbeddedCheckout`). On success Stripe returns the applicant to
`…?fee_checkout=return&session_id=…` which the wizard verifies before treating
the fee as paid; an abandoned/failed payment leaves the applicant on the step
with a clear error and their answers intact. A legacy `mode: "hosted"` redirect
path is still supported for callers that ask for it.
**A manager-owned waiver code (`src/lib/application-fee-waiver.ts`,
`/api/public/application-fee-waiver`) can waive the application fee entirely**
— a redeemed code skips Stripe altogether (no $0 charge, no session).

**`manager_application_fee_waiver_codes` is the only authority on which code is
live.** Two surfaces write it: Applications settings
(`PATCH /api/portal/manager-application-settings`) and the listing save
(`POST /api/property-records`, via `upsertPropertyApplicationFeeWaiverCode`). The
listing save writes only when the request CHANGES the submitted code against the
persisted listing submission, or when the row is being published out of `draft`
for the first time (a draft save deliberately never writes the codes table, so
that transition must apply the typed code). A retired code text is refused before
any write — the unique index is `(manager_user_id, code_normalized)` and ignores
status, so a revoked row still owns its text and is never revived.

Known follow-up limitations (pre-existing, deliberately out of scope for
PRP-456):

- The wizard's "Application fee waive code" field renders
  `submission.applicationFeeWaiverCode` off the stored listing submission, which
  a settings write never rewrites, so the editor can display a code that is no
  longer the live one. The settings GET already returns the property's active
  code; sourcing the field from there is the real fix.
- `listingApplicationFeeWaiverCodeFromPayload` reads `rowData.submission` before
  `propertyData.listingSubmission`. Which container is authoritative for this one
  field is worth normalizing now that a write decision depends on it.

**How often the fee is collected is the manager's `applicationFeeChargePolicy`**
(`first_only`, the default, or `every_time`; on the same manager-level
Application settings row as the fee itself). Under `first_only` — the original
"ONCE per resident PER MANAGER" rule (captain decision, 2026-07-27) —
`shouldWaiveApplicationFeeForResident`
(`src/lib/rental-application/application-policy.ts`) waives a repeat applicant
— one who already submitted an application to, or already paid an application
fee billed by, this property's manager — on any of that manager's listings.
Under `every_time` nothing is waived on history. First-timers pay; history with
a DIFFERENT manager never waives either way.

The waiver is decided **server-side**:
`shouldWaiveApplicationFeeForResidentServer`
(`application-policy.server.ts`) is the authority, and
`POST /api/public/application-fee-preview` resolves the resident from the
SESSION, never from the browser — the client-side `application-policy.ts` copy
reads the local catalog and is a display path only. The preview client caches on
the VIEWER's id as well as the listing (`repeat-applicant` is per-person, so a
signed-out answer replayed after sign-in would charge a genuine repeat applicant
a fee they are owed a waiver on). Coverage:
`tests/unit/application-fee-preview-route.test.ts`,
`tests/unit/application-fee-preview-cache.test.ts`.

The manager-level policy replaced
the per-listing `applicationFeeOnlyFirstApplication` toggle (now inert on
`ManagerListingSubmissionV1`, kept only so stored submissions normalize); its
sibling `allowMultiplePropertyApplications` is likewise inert —
`residentApplicationSubmitBlocked` always allows applying to multiple
properties/rooms and blocks only an exact same-property + same-room PENDING
duplicate. Coverage: `tests/unit/application-policy.test.ts`.

**The application fee is configured ONCE per manager, in Application system
settings — NOT on listing Pricing** (PLAN-0924-1254; earlier captain decision
2026-07-26). The manager-level value lives on
`manager_automation_settings.row_data.applicationSettings`
(`src/lib/manager-application-settings.ts`, `GET/PATCH
/api/portal/manager-application-settings`) and is surfaced under Settings →
**Applications → Application system** (cost + charge policy), alongside promo
waiver codes under Handling. Source-of-truth rule
(`effectiveApplicationFeeCents`): the Application system fee is authoritative
for EVERY listing (including an explicit `0` = free); listing
`applicationFee` fields are ignored. Until the manager saves a value it is
`null` and the resolver uses the legacy $50 default. Pricing no longer
edits the fee. Coverage: `tests/unit/manager-application-settings.test.ts`
and `tests/unit/application-fee-inline-checkout.test.ts`.

**Pipeline order and lease signing fee** live on
`manager_automation_settings.row_data.leasingPipeline`
(`src/lib/leasing-pipeline-preferences.ts`): application↔lease order,
required flags, and optional Stripe lease signing fee (each signer pays).
Lease-first unlocks resident Lease before application approval; send-gate
skips the approved-application check. Coverage:
`tests/unit/leasing-pipeline-preferences.test.ts`,
`tests/unit/lease-signing-fee.test.ts`.

**A holding deposit is never collected AUTOMATICALLY during the application.**
It used to be tracked as a pending `holding_deposit` household charge the moment
an applicant paid (or submitted) the application fee, credited later against the
security deposit at approval. That automatic pre-approval tracking was removed
(`recordApplicationCharges` / `recordSubmittedApplicationFeeCharge` no longer
call `ensurePendingHoldingDepositCharge`) — deposit money is charged under
Payments, after approval, same as security deposits already were.

The one pre-approval `holding_deposit` write that remains is **manager-initiated
and per applicant**: `setApplicantHoldingFee`, reached from the Applications
detail's top-right **Holding fee** action, which opens
`ApplicationHoldingFeeModal` (`application-holding-fee-box.tsx`). It is opt-in,
the manager picks the amount, then **Preview & update** opens
`PortalNotificationPreviewModal` (same Tours / Add payment pattern) before the
charge is written — confirm sends inbox/email/SMS notice (or fee-only via skip).
It needs both an applicant email and a property to scope the charge, and a hold
the applicant has already PAID is never re-priced or deleted from there.
`ensurePendingHoldingDepositCharge` and the approval-time holding-deposit credit
(`paidHoldingDepositCreditCents`) are kept for now as `@deprecated`/back-compat
only; do not add new AUTOMATIC pre-approval call sites.

Coverage (application fee + waiver codes): `tests/unit/application-fee-checkout-fee-payer.test.ts`
(Connect destination, ownership guard, server-stored fee amount, plan-based
itemization) and `tests/unit/application-fee-waiver.test.ts` (code CRUD,
manager scoping, and the cross-manager-isolation + expiry/usage-cap redemption
guards).

Coverage: `tests/unit/resident-processing-fees.test.ts` (fee amounts, resolver,
breakdown, acceptance table), `tests/unit/service-fee-by-plan.test.ts` (settings
normalization + plan transitions), `tests/unit/stripe-axis-ach-checkout.test.ts`
(the params actually sent to Stripe for each fee-payer: line items,
`application_fee_amount`, `transfer_data` destination, no `on_behalf_of`), and
`tests/unit/stripe-ledger-fees.test.ts` (fee attribution).

**A third funding model exists behind a flag: the PropLane balance ledger
(night/vendor-pay, `PROPLANE_BALANCE_ENABLED`, default off).** When on,
`createHouseholdChargeCheckout` passes `fundingModel: "platform_ledger"` to
`createAxisAchCheckoutSession` — the ONE new branch in that builder — instead
of resolving a destination account: no `transfer_data`, no
`application_fee_amount`, no `platform_hold` metadata; the charge lands on the
platform outright (separate charges and transfers). The resident-facing fee
math (`residentServiceFeeBreakdown`) is byte-identical either way — only where
the settled money goes changes. The `checkout.session.completed` webhook
credits `manager_payout_cents` as a PENDING entry in the manager's PropLane
balance (`src/lib/proplane-balance/household-charge-credit.server.ts`),
available once Stripe's own balance-transaction `available_on` passes. Nothing
else (application fees, vendor-invoice-pay checkout, autopay) ever requests
this funding model, and with the flag off `createHouseholdChargeCheckout`
resolves the SAME destination-or-hold path it always has. See
`.lavish/night/build-vendor-pay.md` for the full architecture and the
switch-on checklist.

**The destination is per-manager when they are ready.**
`resolveConnectDestinationIfReady` (`src/lib/stripe-connect.ts`) reads that
manager's own `profiles.stripe_connect_account_id` and returns the account id
only when transfers are active and `payouts_enabled`. Otherwise the session
is a platform hold — never a 422 for missing Connect. This holds for
household charges (`stripe-household-charge-checkout.server.ts`), application
fees (`application-fee-checkout.server.ts`), and autopay
(`resident-autopay.server.ts`). Manager Payment setup still shows "Connected"
ONLY when Stripe reports the account can actually receive money; an
existing-but-unfinished account reads as "incomplete"
(`src/lib/stripe-setup-state.ts`). Coverage:
`tests/unit/manager-connect-destination-routing.test.ts` (per-manager
destination isolation + hold when not onboarded),
`tests/unit/stripe-connect.test.ts` (the resolver gate), and
`tests/unit/stripe-setup-state.test.ts` (the UI truth mapping).

**Ledger attribution: the Stripe fee is NOT the manager's.** `ledger_entries` is
the manager's book, so `enrichLedgerPaymentFromStripeCharge` writes
`stripe_fee_cents = 0` and `net_cents = charge.amount - application_fee` (the
destination transfer), rather than the platform balance transaction's fee/net.
PropLane's real cost lives in PropLane's own Stripe balance. Do not post a
`stripe_fee` GL entry against a manager — nothing left their payout.

**Every pre-Stripe confirmation states the exact total, itemizing any service
fee the resident pays.** The resident payments panel resolves its manager's
fee-payer once (`/api/portal/resident-service-fee`) and, when the resident pays,
itemizes the fee in BOTH the confirm dialog (whose button reads "Pay <total>",
never "Continue to Stripe" — every payment happens inside PropLane) and the
embedded-checkout breakdown — computed from `residentProcessingFeeCents` /
`residentProcessingFeeDisplayLabel`, the SAME functions checkout uses, so the
disclosure can never understate what Stripe collects (a QA sweep on 2026-07-21
caught the confirm dialog understating a card payment by $515.96; deriving the
disclosure rather than re-deriving the amount is what prevents that). When the
manager or PropLane covers the fee, the resident pays face value and the surface
shows "no added fees". NEVER hard-code "$0.00 added fees" — that lies to a Free /
Pro-resident resident who does pay one.

While an ACH debit clears (3–5 business days) the charge status is
`"processing"` (persisted by the webhook's `checkout.session.completed`
unpaid branch and the verify route). Everything that keys on
`status === "pending"` — late fees, payment reminders, re-pay, overdue —
automatically ignores it. `async_payment_succeeded` → paid;
`async_payment_failed` reverts processing→pending (NSF/`failed` belong to the
`payment_intent.payment_failed` handler only — never double-fee).

Alternate flat-cents rails (Plaid Transfer / Dwolla / Moov, ~$0.25/transfer)
only beat Stripe above ~1,000 payments/month once monthly minimums are counted
— re-evaluate at that scale, not before.

## A resident pays through PropLane only — off-platform channels are gone (PLAN-0916)

`ResidentAcceptedPaymentMethod` is `"ach" | "card"`, and
`acceptedPaymentMethodsForListing` keeps only those two whatever a stored
listing still lists. `isPayableHouseholdCharge` and `filterChargesForPayMethod`
are PropLane/Stripe alone (`src/lib/platform/resident-payments.ts`); the
resident payments panel has no manual-channel branch. `residentPaymentMethodsSummary`
says either "PropLane payments — bank (ACH), card (Apple Pay), or Link" or, when
the manager has not finished setup, to ask the manager to finish it.

There is no receipt inbox, no Gmail connection, no "I paid by hand" report from
the resident, and no per-charge payment reference code. `HouseholdCharge` has no
`zelleContactSnapshot` / `venmoContactSnapshot` / `manualPaymentChannel` /
`paymentReference` fields; a legacy row that still carries them is ignored on
read. `ManagerManualPaymentSettings` (the name is historical) holds only
`axisPaymentsEnabled` and the service-fee payer. `normalizeManagerListingSubmissionV1`
strips `RETIRED_LISTING_PAYMENT_KEYS` so a lease clause or the public listing
can never print a retired handle. The application fee is paid inline through
Stripe only — the "Other / manager instructions" fee channel went with it.

A payment the manager took by hand (cash, check) is still recorded with the
`mark_charge_paid` tool or the ledger's Mark paid action. Vendors are paid by
ACH through Stripe Connect only (`VendorAcceptedPaymentMethod` is `"ach"`).
Guard: `tests/unit/no-off-platform-payment-channels.test.ts`.

# Resident Payments section: Charges-only (§9.3, post-financials-merge)

**Payments is Charges-only.** There are no URL sub-tabs and no `TabNav` switcher: the section is one screen at the bare `/resident/payments`, rendered by `ResidentPaymentsPanel` (the former `ResidentFinancialsPanel` was merged into it, then its Summary + Statements views were removed from the resident portal). The panel takes only `initialStatus` — the `tabId`/`basePath` props existed solely to serve those tabs and are gone, in `demo-section-renderer.tsx` too. `PAYMENTS_TABS` no longer exists; both resident section registries in `resident-sections.ts` declare `tabs: []`, so the sidebar links straight to `/resident/payments`.

Pending / Overdue / Paid are in-section status pills, not tabs. `RESIDENT_PAYMENTS_LEGACY_TABS` is a `{ status?: string }` map of every old sub-path (`charges`, `summary`, `statements`, `balance`, `pending`, `overdue`, `paid`); `renderPortalSection` redirects all of them to `/resident/payments`, preserving `?status=` for the three that map to a pill (forwarded as the panel's `initialStatus`). `/resident/financials/*` redirects the same way. The map is a **null-prototype** object so inherited `Object.prototype` keys (`toString`, `constructor`, `__proto__`, `hasOwnProperty`) do not read as known tabs — unknown sub-paths still `notFound()`. See AGENTS.md "Financials UI cleanup" for the routing gotchas, and `tests/unit/resident-payments-charges-only.test.ts` for the regression coverage on the empty `tabs`, the bare smoke path, and the legacy map (including the prototype-key case).

`/api/reports/resident-ledger` is live (resident Documents → Rent receipts).

## A not-yet-due charge stays off every resident surface until 7 days before due

`residentCanSeeCharge` / `residentVisibleCharges` (`src/lib/household-charge-visibility.ts`)
is the ONE visibility rule, and every resident surface applies it: the Payments panel
(`resident-payments-panel.tsx` — rows, counts, and the amount-due figure all derive
from that filtered list), the resident dashboard (its Payments rows, count, and
balance; the tenancy unlock still reads EVERY charge through `chargesImplyTenancy`),
`queryResidentBalance` (`get_my_balance`), and the `list_my_charges` tool — the
assistant never talks about a charge the screen does not show. A `pending` charge is
hidden until its due date is within `RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS` (7,
inclusive). Always visible: overdue, `processing`, `partially_paid`, and `paid`
charges; a charge with no parseable due date; every upfront move-in line and any
`blocksLeaseUntilPaid` charge (`isAlwaysResidentVisibleCharge`); and a charge carrying
`residentVisibleAt`. Use `residentVisibleCharges` on a list, never the per-charge
predicate: a move-in group stays whole, so a line whose own due date sits outside the
window still shows whenever any sibling line does.

`residentVisibleAt` is server-owned. `POST /api/portal/send-payment-reminder` stamps
it on every charge an accepted manual reminder covered (re-reading the row and merging
only that field, so a status change that landed during delivery is never overwritten);
the charges mirror route (`POST /api/portal-household-charges`) and the browser
reconcile (`reconcileChargeWithLocal`) both carry a stored stamp through a client copy
that predates it. The manager-side Upcoming group is a different rule
([financials.md](financials.md) § Manager charge counts). Coverage:
`tests/unit/household-charge-visibility.test.ts`,
`tests/unit/resident-payments-visibility.test.ts`,
`tests/unit/tools/charges-upcoming-visibility.test.ts` (`list_my_charges`), and the
browser regression `npm run test:payments-upcoming` (`tests/browser/payments-upcoming/`).

## Paid is reconciled against the ledger, and receipts are named from it

Payments › **Paid** and Documents › **Rent receipts** answer the same question
("what have I paid") from two different stores — the live charge list
(`portal_household_charge_records`) and the accounting record (`ledger_entries`)
— so they used to contradict each other outright: eleven receipts on one screen,
"Paid 0" on the other, because a paid charge that is later deleted leaves its
ledger payment behind. `src/lib/resident-recorded-payments.ts` is the one place
that reconciles them; its header comment carries the full rationale. Rules:

- **Paid reconciles UP to the ledger, never down.** A recorded payment with no
  surviving charge row is synthesized as a READ-ONLY row that is always
  `status: "paid"` — so every pay/select path (all of which filter on `pending`)
  ignores it by construction, and it opens no charge detail page. Nothing is
  deleted from either store, and no payable state is invented. The ledger/GL
  write model is untouched: a deleted charge still does not reverse its ledger
  entry, which is a financials-domain change, not a display one.
- **The synthesized rows are DERIVED from (ledger rows, live charges), never
  stored.** Stored, they freeze against the charge snapshot they were built
  from, so a charge that reappears (a sync restore, a deferred load) renders
  BESIDE its synthesized twin — the double-count this reconciliation exists to
  prevent. They are also scoped to the identity they were read for, so an
  in-session account switch can never show the previous resident's money.
- **Both surfaces default to the same window** (`residentLedgerReceiptRange`,
  trailing 12 months, LOCAL calendar dates at both ends because `posted_date` is
  a plain date). Two default windows would make the counts disagree again for a
  new reason. Documents lets the resident pick another range, which is why the
  shared client cache (`src/lib/resident-ledger-client.ts`) keys on viewer
  identity **and** window — see "Performance & egress" in AGENTS.md.
- **Paid rows show the amount PAID, not the balance** — the outstanding balance
  is `$0.00` by definition on Paid, so showing it turned every settled row into
  `$0.00`. The unpaid buckets still show what is owed.
- **A receipt is named from its own ledger description**
  (`receiptRowLabel` / `recordedPaymentTitle`) **on every surface that names one**
  — the Rent receipts table, its inline viewer, and Download all — so a utilities
  or deposit payment no longer reads "Rent receipt". The empty-description
  fallback is a neutral `"Payment"`, never `"Rent payment"` — this label lands on
  an exportable financial record. The Documents tab itself is still called
  "Rent receipts".
- `queryResidentLedger` emits `sourceChargeId` and `property` on each row for the
  match. They are deliberately NOT `columns`, and exports iterate `columns`, so
  CSV/PDF output is unchanged.

Coverage: `tests/unit/resident-recorded-payments.test.ts`,
`tests/unit/resident-ledger-client.test.ts`, `tests/unit/rent-receipts.test.ts`.

## Application-fee copy comes from one module

The wizard's Review step and its fee step must never quote different amounts for
the same charge — Review printed the LISTING's published fee unconditionally
while the next screen said no fee was required. Both now derive their copy from
`src/lib/rental-application/application-fee-display.ts`: Review shows what will
actually be charged (`$0.00` when waived) plus a note naming the listing's
published fee and the waiver reason, and the waiver sentence itself comes from
the shared `applicationFeeWaiverExplanation`. Add any new fee-copy surface there
rather than re-deriving it. Coverage:
`tests/unit/application-fee-display.test.ts`,
`tests/unit/application-fee-review-step.test.tsx`.

## Charges follow the LEASE, not the application

Only two moments create money, and **approval is not one of them**:

| Moment | What is generated |
| --- | --- |
| Application submitted | the `application_fee`, and nothing else |
| Approved, lease unsigned | **nothing** — an approval is a decision, not a bill |
| Lease executed | the whole schedule (deposit, first/prorated rent, utilities, move-in and one-time fees, and the recurring rent profile) |

`recordApprovedApplicationCharges` is named for the moment it was ORIGINALLY
called from, not for a check it performed. It used to bill the full move-in
schedule for anyone the reconciler handed it — including a submitted applicant
nobody had approved — because `shouldReconcileResidentPaymentSchedule` admitted
`bucket: "pending"` rows and the generator itself never looked at approval. Those
are persisted rows, so every one also posted to the manager's ledger via
`syncLedgerChargeEntry` and emitted a resident-addressed `charge_created` event.
The applicant opened their dashboard to eight pending and overdue payments on a
home they had not been given, linking to a `/resident/payments` the stage guard
then bounced straight back.

The rules that hold it closed:

- **Two predicates, never one.** `shouldRetainResidentPaymentSchedule` answers
  "whose existing charges survive a reconcile wipe" and is deliberately WIDER — a
  submitted applicant belongs there so a manager's hand-added charge is not
  deleted on the next portal load (the regression `6aeb64df` fixed).
  `residentChargeMoment` answers "whose charges are GENERATED". Collapsing them
  back into one predicate is how this bug happened.
- **The SIGNATURE bills, whatever the application bucket says.** A lease can be
  executed while its application row still reads pending; the person signed, so
  they are a tenant. What the bucket can never do is bill someone with no lease.
  `manuallyAdded` is its own sufficient signal — a manager hand-onboarding an
  existing tenant is asserting the tenancy and may never file a lease here.
- **The gate is at the door**, inside the generator, because four call sites reach
  it and each one can forget. `leaseExecuted` is injected (`opts.leaseExecuted`)
  rather than read inside, since `household-charges` cannot import
  `lease-pipeline-storage` cheaply; the reconciler reads
  `executedLeaseIdentities` ONCE per pass instead of rescanning per resident. The
  default is fail-closed and degrades safely: a caller that omits it stops
  REGENERATING, it never deletes, and next month still materializes from the
  stored recurring profile.
- **"This person has charges" is not authorization.** Both resident surfaces
  (`resident-dashboard.tsx`, `resident-payments-panel.tsx`) separately let charges
  unlock Payments so a manager-added resident can pay before their application row
  reaches the local cache. `chargesImplyTenancy` is the one answer: an
  `application_fee` or `holding_deposit` is what a PROSPECT owes and no longer
  counts. Fixing one surface and not the other leaves the hole open.
- **A deposit is not collectible between approval and signature.** That is
  deliberate — the lease is what obliges anyone. A manager who wants money down
  first enters a **holding fee**, which works at any stage and already credits
  against the deposit.
- **Generation is browser-only and manager-side**, so a freshly signed lease is
  billed on the manager's next portal load, not the instant the resident signs.
  Pre-existing (`getPropertyById` needs the manager's local listing catalog).

Coverage: `tests/unit/charges-follow-the-lease.test.ts`,
`tests/unit/current-resident.test.ts`.

**A migrated month covers the generator.** A migrated rent charge
(`migrationSourceId` set, `kind: "rent"`, and a `rentMonth`) is all-in —
`syncAllRecurringRentCharges` skips generating BOTH the recurring rent and utilities
charges for that resident/property/month, instead of keying off `chargeBusinessKey`
(which deliberately returns a unique key per migrated row and so never dedupes here).
The match is on `rentMonth`: the sales-migration `importCharge` stamps it (`YYYY-MM` of
the fact date) on `chargeKind: "rent"` rows and the Ambika occupancy script sets it
too; a migrated rent row imported without one does not cover the generator. Coverage:
`tests/unit/household-charges-migrated-month.test.ts`.

### Signature freezes the money terms

Signing never used to write the signed rent onto the resident's record, so every
Payments load re-priced a signed tenant from the CURRENT listing
(`selectedRoomRentAmount` → the room's `monthlyRent`). A manager editing a room's
rent moved a signed resident's pending rent and recurring profile with it.

`src/lib/lease-signed-terms.ts` owns the rule. The moment a lease is fully
executed — marked signed off-platform (`lease-mark-signed.client.ts`) or, for an
e-signature this browser learns of on its next load, the reconciler
(`reconcileApprovedResidentPaymentSchedules`) — the four money terms the document
states (rent, monthly utilities, security deposit, move-in fee) are written onto
the application row as `signedMonthlyRent` plus the `manager*Override` fields,
**only where still empty**. The generator already prefers those fields over the
listing at every money line, so from then on the listing can change freely; only
a renewal or amendment (`lease-renewal-payments.ts`) moves a signed resident's
terms. Source order: the executed document (generated summary table or uploaded
PDF parse), else the billing snapshot at that moment. A daily- or weekly-priced
room keeps its rate — a frozen MONTHLY figure would switch it to flat billing —
so only its utilities, deposit and move-in freeze. The reconciler pass doubles
as the backfill for residents signed before this existed.

A recurring profile is keyed by resident **and** property. The reconciler
retires a profile whose resident no longer has a current row on that property,
together with the untouched pending months it billed; a paid, partially paid, or
resident-reported month is history and stays. Retaining profiles by email alone
is how a moved resident got two "Rent — October" rows at two prices.

Coverage: `tests/unit/lease-signed-terms.test.ts`.

**UI location (C145):** saved payment methods and the autopay card live in
Settings › Account, alongside sign out (`ResidentPaymentMethodsSettingsCard`,
`resident-payment-methods-settings-card.tsx`) — not in the Payments list,
which keeps owning charge history and the per-charge Pay flow. A declined
autopay run's "Pay now" routes to `/resident/payments?pay=<chargeId>`, the
same shortcut the dashboard's Balance due uses (C248) to open the pay
confirmation directly.

## Autopay: one run per charge, the SAME builder and fee resolver as a manual payment (PLAN-0920-1051 Wave 1)

Autopay covers **recurring charges only** — `rent` and `utilities`
(`AUTOPAY_RECURRING_KINDS` in `src/lib/resident-autopay.server.ts`). One-off
charges (fees, deposits, damages) are never enrolled and still need a manual
Pay. It runs **on the due date by default**; the resident may move it up to 5
days earlier (`run_days_before_due`, 0-5, captain decision 2026-09-20).

**Enrollment is per resident per household**
(`resident_autopay_settings`, unique on `(resident_user_id, household_key)`),
where `household_key` is the same `lower(residentEmail)|propertyId` key
`recurringRentProfileKey` already groups a resident's recurring charges by
(`src/lib/resident-autopay.server.ts`'s `residentAutopayHouseholdKey`).
`resolveResidentAutopayHousehold` is the one place that resolves "the
resident's current household" from their charges — the `/api/resident/autopay`
route and the `set_autopay` agent tool both call it, so chat and the Payments
page can never disagree about what is enrolled. A resident with more than one
tenancy under the same manager names it with an optional `propertyId` (query on
GET, body on PUT, tool input), validated against the charges they actually
hold; absent, the pick is deterministic — the property of the soonest-due
unpaid recurring charge, ties broken by `propertyId` ascending. Its
`nextCharge` (the "Next payment" preview) is the soonest unpaid charge with no
run row yet, i.e. exactly what the sweep will pick up.

**The double-charge guard is a unique constraint, not a lock.**
`resident_autopay_runs.charge_id` is UNIQUE; `claimRun` inserts a `claimed` row
before charging anything, and a unique-violation on that insert means another
pass already claimed this charge, so the caller skips. `listAutopayDueCharges`
(the daily `/api/cron/run-autopay` cron, `0 8 * * *` UTC) lists a charge that
is unpaid, recurring-kind, enrolled, has NO run row yet at all — of any status
— and whose run date (due date minus days-before) is **today or earlier in
Pacific time** (`pacificCalendarDateYmd`), so a pass that was skipped or a
resident who enrolled after the due date is still paid; the run row, not the
date match, is the double-charge guard. The PaymentIntent is created with
`idempotencyKey: autopay:<runId>:<attempt>`, so a lost response to a confirmed
create can never become a second debit on retry. The cron re-reads
`workspaceAutopayEnabled` per property on BOTH passes: a manager turning
autopay off stops every debit, not just new enrollments. Its auth fails closed
on Vercel (`CRON_SECRET` required outside localhost), like `comms-billing-invoice`.

**The off-session PaymentIntent reuses the manual checkout's own resolvers,
never a forked fee calculation.** `chargeAutopay`
(`src/lib/resident-autopay.server.ts`) calls the exact same
`loadHouseholdChargesForCheckout` (ownership/eligibility) and
`resolveHouseholdChargeFeePayer` (extracted from
`stripe-household-charge-checkout.server.ts`, also used by
`createHouseholdChargeCheckout`) that a manual payment uses, then
`residentServiceFeeBreakdown` for the numbers — the SAME single source of
truth this file describes above. Only the Stripe object differs: a manual
payment creates a Checkout Session (someone is present to complete it); autopay
creates a PaymentIntent directly with `confirm: true, off_session: true`,
setting `transfer_data.destination` and `application_fee_amount` straight on
the PaymentIntent instead of nested under a session's `payment_intent_data`.
Marking the charge paid also reuses the manual path's own per-charge core
(`markOneHouseholdChargePaid` in `stripe-household-charge.ts`), so the ledger
write-through, reminder cancellation, and outbound webhook are identical
either way. `payment_intent.succeeded` / `.payment_failed` additively update
the `resident_autopay_runs` row in `stripe-webhook-financials.ts`; a declined
PaymentIntent still carries `metadata.charge_id`, so the EXISTING
`handlePaymentIntentFailed` flips the charge to `failed` (and creates an NSF
fee if the manager's billing settings call for one) exactly like a declined
manual payment, and the autopay-specific handler only additionally updates the
run row and sends the decline notice.

**A manager setting gates enrollment, per workspace** — `payment_settings`
jsonb on `portal_workspaces`, alongside `serviceFeePayer` (see above):
`autopayEnabled` (default On) and `autopayRetryEnabled` (default On, meaning a
declined run may retry once). `workspaceAutopayEnabled` /
`workspaceAutopayRetryEnabled` (`workspace-payment-settings.server.ts`) are the
readers; `GET/PUT /api/resident/autopay` refuses to turn autopay on when the
workspace has it off, and the cron only retries a failed run when the same
workspace's retry setting still allows it.

**The one allowed retry is three-plus days after a decline, tracked by the
`attempt` column on the run row** (`AUTOPAY_MAX_ATTEMPTS = 2`). `retryAutopayRun`
transitions the existing `failed` row back to `claimed` in place and bumps
`attempt` (the unique `charge_id` means a retry cannot claim a second row); the
update is conditional on the row still being `failed` at that attempt and
reports whether it transitioned, so two overlapping passes cannot both charge.
A failed row at the max is never retried, whether the failure was recorded
synchronously by `chargeAutopay` or days later by the webhook — an ACH decline
always arrives asynchronously, which is why a string tag on `failure_reason`
was not enough. The webhook ignores a redelivered decline whose
`metadata.autopay_attempt` is older than the row's current attempt.

**Resident notice on decline**: `notifyAutopayDeclined` sends "Autopay could
not pay `<charge title>` — `<decline reason>`. Nothing was charged." through
the same `deliverPaymentReminder` path a manual reminder uses, so it lands
wherever the resident already receives payment notices per their preferences.

Coverage: `tests/unit/resident-autopay.test.ts`,
`tests/unit/resident-payments-autopay.test.tsx`.

**A resident's `manager_id` is not guaranteed to be a valid UUID** (a legacy or
corrupt fixture row is a real case, not just theoretical — it 500'd every
`/resident/move-in` load until fixed). `resolveResidentAutopayHousehold`
treats Postgres's `22P02 invalid input syntax for type uuid` the same as an
empty result — no valid manager link means no autopay household — rather than
letting the raw DB error bubble up as a 500. Any new query keyed on a
resident's `manager_id`/`resident_user_id` should do the same rather than
assume the column always holds a well-formed id.
