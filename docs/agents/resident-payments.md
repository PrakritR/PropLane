> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Resident payments: who pays the service fee depends on the manager's plan + clearing-window `processing` status

**No subscription includes processing-fee coverage** (captain decision September 10, 2026).
All plans default to resident pays. Pro and Business managers may choose to absorb
the fee through their payout. PropLane covers it only when staff explicitly approve
that manager account through `adminServiceFeeOverride: "proplane"`.

A shared promo code, paid plan, legacy `proplane` selection, or per-listing waiver
code cannot grant coverage. Application-fee waivers remain separate. Subscription
GET exposes `paymentWaiverGranted` from the staff-owned override; a failed read is
unknown and disables coverage selection. Manager settings and staff overrides use
separate atomic RPCs on the same row, so a manager save cannot overwrite a concurrent
staff revocation. Unknown plan reads stop checkout before deciding who pays.

**The money still lands in the manager's own connected account.** Every resident
payment stays a Connect **destination charge** on the PLATFORM account
(`transfer_data.destination = <manager connected account>`, **never** a direct
charge / `on_behalf_of` / a `Stripe-Account` header). Only who bears the fee
moves, via `application_fee_amount`:

| Fee payer | Resident charged | `application_fee_amount` | Manager receives | PropLane net |
| --- | --- | --- | --- | --- |
| resident (Free, or an explicit paid-plan choice) | subtotal + fee | fee | subtotal | ≈ 0 |
| manager (explicit paid-plan choice) | subtotal | fee | subtotal − fee | ≈ 0 |
| proplane (explicit staff account approval only) | subtotal | omitted | subtotal | − Stripe's fee |

`src/lib/payment-policy.ts` is the single source of truth:
- `residentProcessingFeeCents(subtotal, method)` — Stripe's cost (ACH 0.8% cap
  $5; card/Link 2.9% + $0.30). A pass-through, never a markup.
- `resolveServiceFeePayer(tier, proChoice)` — the plan rule above. `tier` is the
  normalized SKU tier (`normalizeManagerSkuTier(...) ?? "free"`), so a
  legacy/unknown tier resolves to `resident`.
- `resolveServiceFeePayerFor({ tier, adminOverride, propertyChoice, managerChoice, waiverGranted })`
  — the ONE resolver the money paths call. Precedence, most specific first:
  **staff override → the property's own Pricing setting → the manager's account
  default → the plan default**. Steps 2-4 stay subject to the plan rule above;
  the staff override deliberately ignores it, because staff absorbing a
  free-tier manager's fees is the whole point of that control.
  `managerCanSelectProplaneServiceFee(tier, accountApproved)` /
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

**Choosing `proplane` for the ACCOUNT also requires a valid waiver code** (or an
account-level grant), because it spends PropLane's own money either way.
`resolveSavedServiceFeeSelection` (`manager-manual-payment-settings.ts`) is the one
decision: a NEW `proplane` selection with no valid `serviceFeeWaiverCode` falls back
to `resident`, exactly as `persistListingServiceFeePayer` does, while a save that
merely CARRIES FORWARD an account already stored on `proplane` keeps it — legacy rows
carry no code, so an unrelated toggle must not quietly move Stripe's cost onto their
residents. `PATCH /api/portal/manager-manual-payment-settings` REFUSES the code-less
new selection with **400** rather than storing the downgrade and answering 200, and
`saveManagerManualPaymentSettings` THROWS when the stored settings cannot be read at
all: a failed read cannot tell a legacy absorber from a code-less new choice. The
Payment setup modal asks for the code inline and saves nothing until it matches, and
it refuses to write anything before its own settings GET has succeeded — the draft
defaults to `resident`, so one click on the Stripe checkbox would otherwise overwrite
a stored `proplane` with a choice the server cannot refuse. Coverage:
`tests/unit/manager-service-fee-waiver-code.test.tsx`.

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
drops whatever the caller supplied and restores the stored value, and staff write
it through `saveAdminServiceFeeOverride` behind `GET/PATCH
/api/admin/manager-service-fee`, which is where the admin check lives. `null`
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
`resolveServiceFeePayer` + the manager's `loadManagerManualPaymentSettings`,
exactly like a household charge — Free applicants pay the fee, Pro follows the
manager's choice, Business is absorbed by PropLane. The listing page itself
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

**The application fee is configured ONCE per manager, in Application settings —
NOT per listing** (captain decision, 2026-07-26: "manager sets cost of
application in application rather than in the property listing"). The
manager-level value lives on `manager_automation_settings.row_data.applicationSettings`
(`src/lib/manager-application-settings.ts`, `GET/PATCH
/api/portal/manager-application-settings`) and is surfaced under the manager's
**Applications** section ("Application fee" → `ManagerApplicationSettingsModal`,
alongside the fee-waiver codes so fee + waiver live together). The same row also
carries `applicationFeeChargePolicy` (above) and an optional manager-level
pay-by-other channel (`applicationFeeOtherEnabled` /
`applicationFeeOtherInstructions`); a listing that still sets its own legacy
`applicationFeeOther*` fields wins over it
(`resolveApplicationFeeOtherInstructions`). Source-of-truth
rule (`effectiveApplicationFeeCents`): a configured manager-level fee is
authoritative for EVERY listing (including an explicit `0` = free); until the
manager saves one it is `null` and the resolver GRANDFATHERS each listing's
stored `applicationFee`, so no live listing silently changes what it charges on
deploy. The settings modal pre-fills a non-persisted *suggestion* (the mode of
the manager's existing per-listing fees, `suggestedManagerApplicationFeeCents`)
so the first save is an explicit, previewed consolidation — never a silent bulk
change. New listings no longer carry a per-listing fee field. There is
deliberately NO data migration moving fees off listings (avoids a second prod
migration and any silent charge change); the move is a resolver + config change.
Coverage: `tests/unit/manager-application-settings.test.ts` (the money-critical
override + grandfather + free-fee cases) and
`tests/unit/application-fee-inline-checkout.test.ts` (embedded-by-default).

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

**The destination is per-manager and the gate has NO platform fallback.** The
`transfer_data.destination` is resolved from the paying charge's owning manager
via `resolveAndValidateManagerConnectForPayments` (`src/lib/stripe-connect.ts`),
which reads that manager's own `profiles.stripe_connect_account_id`. If the
manager has not onboarded (no account) or Stripe reports transfers not yet active
(onboarding incomplete), the checkout is REFUSED
(`MANAGER_NO_CONNECT_ACCOUNT` / `MANAGER_CONNECT_TRANSFERS_NOT_READY`) before any
session is created — a charge is never silently routed to the platform account.
This holds for both household charges (`stripe-household-charge-checkout.server.ts`)
and application fees (`api/stripe/application-fee-checkout/route.ts`). Manager
Payment setup shows "Connected" ONLY when Stripe reports the account can actually
receive money; an existing-but-unfinished account reads as "incomplete"
(`src/lib/stripe-setup-state.ts`). Coverage:
`tests/unit/manager-connect-destination-routing.test.ts` (per-manager destination
isolation + the no-onboard block, real resolver against a fake DB),
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
itemizes the fee in BOTH the "Continue to Stripe?" confirm dialog and the
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

## A resident pays through PropLane only — Zelle and Venmo are retired

`ResidentAcceptedPaymentMethod` is `"ach" | "card"`, and
`acceptedPaymentMethodsForListing` keeps only those two whatever a stored
listing still lists, so a legacy `acceptedPaymentMethods` array cannot put a
retired rail back in front of a resident. `isPayableHouseholdCharge` is
PropLane/Stripe ACH alone, and `residentManualChannelsForCharges` /
`availableManualChannelsForCharges` return an empty list — the resident panel's
manual-channel branch is therefore unreachable rather than deleted.
`residentPaymentMethodsSummary` says either "PropLane payments — bank (ACH),
card (Apple Pay), or Link" or, when the manager has not finished setup, to ask
the manager to finish it; it never advertises a channel the product no longer
accepts.

The manager side is normalized to match rather than trusted:
`normalizeManagerManualPaymentSettings` forces `zellePaymentsEnabled` /
`venmoPaymentsEnabled` off and their contacts empty, and
`applyManagerManualPaymentsToListings` clears the per-charge
`zelleContactSnapshot` / `venmoContactSnapshot`. Payment setup no longer offers
Link Zelle / Link Venmo. `normalizeManagerListingSubmissionV1` does the same for
the listing copy so a lease clause cannot promise a retired channel — see
[`lease-generation.md`](lease-generation.md) § "Payment instructions read the
NORMALIZED listing".

The receipt-matching pipeline behind those channels still exists but is
switched off in one place; it is documented in
[`manual-payment-detection.md`](manual-payment-detection.md).

# Resident Payments section: Charges-only (§9.3, post-financials-merge)

**Payments is Charges-only.** There are no URL sub-tabs and no `TabNav` switcher: the section is one screen at the bare `/resident/payments`, rendered by `ResidentPaymentsPanel` (the former `ResidentFinancialsPanel` was merged into it, then its Summary + Statements views were removed from the resident portal). The panel takes only `initialStatus` — the `tabId`/`basePath` props existed solely to serve those tabs and are gone, in `demo-section-renderer.tsx` too. `PAYMENTS_TABS` no longer exists; both resident section registries in `resident-sections.ts` declare `tabs: []`, so the sidebar links straight to `/resident/payments`.

Pending / Overdue / Paid are in-section status pills, not tabs. `RESIDENT_PAYMENTS_LEGACY_TABS` is a `{ status?: string }` map of every old sub-path (`charges`, `summary`, `statements`, `balance`, `pending`, `overdue`, `paid`); `renderPortalSection` redirects all of them to `/resident/payments`, preserving `?status=` for the three that map to a pill (forwarded as the panel's `initialStatus`). `/resident/financials/*` redirects the same way. The map is a **null-prototype** object so inherited `Object.prototype` keys (`toString`, `constructor`, `__proto__`, `hasOwnProperty`) do not read as known tabs — unknown sub-paths still `notFound()`. See AGENTS.md "Financials UI cleanup" for the routing gotchas, and `tests/unit/resident-payments-charges-only.test.ts` for the regression coverage on the empty `tabs`, the bare smoke path, and the legacy map (including the prototype-key case).

`/api/reports/resident-ledger` is live (resident Documents → Rent receipts).

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
