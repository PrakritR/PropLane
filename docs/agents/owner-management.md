# Owner management: owners pay for PropLane management, rent splits per home

Authoritative for this feature. Plan/lane: `on/owners` (W17, one-number build). Money + authorization:
**Stripe TEST mode only while building; never staging or production; agents never run production steps.**

Captain (Oct 18 2026, verbatim): *"what we want to do is have owners paid for our management services
effectively; this is going to include owner system to be in place, include a split payout for each home for rent
being collected; we can have a payout system where we can transfer some money to property owner; try to think
beyond scope to figure out how we can ease property owners' lives in this system."*

## Invariants (read these first)

1. **PropLane never holds owner rent.** For a house under an ACTIVE management agreement whose owner is
   payout-ready, the resident's rent is a Stripe **destination charge** to the OWNER's connected account. The
   management fee is the charge's `application_fee_amount`. That one Stripe object IS the split payout per home.
2. **Fail closed, never pay the wrong account.** The destination is re-derived on the server at every checkout
   from the agreement row (`owner_user_id` -> `profiles.stripe_connect_account_id`, verified `transfers` +
   `payouts_enabled`), never from a request body, and attested again from the provider legs at settlement
   (`attestPlatformDestinationSource`, which also pins `account.metadata.axis_user_id` to the owner). A house with
   an active agreement and an owner who is NOT payout-ready falls back to today's workspace flow, the owner's net
   is booked as `held` (owed) and the manager is alerted. It is never silently routed anywhere else.
3. **Idempotent everywhere.** Allocation rows are unique on `(stripe_payment_intent_id, charge_id)`; every refund,
   dispute and reversal row is unique on its Stripe object id; every ledger/GL post is keyed on the allocation or
   adjustment id; every Stripe write carries an idempotency key derived from those ids. Webhook replays are no-ops.
4. **Ownership is re-derived at every write.** The manager is read from the property record, the owner from an
   accepted `property_owner` membership that grants that house, never from the request.
5. **Only `rent` kinds are routed.** `rent`, `first_month_rent`, `prorated_rent`, `prorated_last_month_rent`.
   Security deposits stay in trust (liability, workspace flow), application and holding fees, utilities, services,
   short-stay totals, late fees and everything else keep today's flow. A cart that mixes routed and unrouted kinds
   is refused (422 `MIXED_OWNER_ROUTING`) so one Checkout never has two destinations.
6. **Flag safety.** No active agreement = byte-for-byte today's behavior. Code that reads a new table treats
   Postgres 42P01 / 42703 and PostgREST PGRST205 as "nothing there" (prod runs code before migrations).

## Stripe research (docs.stripe.com, read Oct 18 2026)

| Topic | What the docs say | What we do |
| --- | --- | --- |
| Destination charge | Charge is created on the platform; the FULL amount is transferred to `transfer_data[destination]`; `application_fee_amount` is then transferred back; **the platform pays the Stripe fee** out of its amount, and refunds/chargebacks debit the platform. | Application fee = management fee + the same processing-fee component the workspace flow already uses (`residentServiceFeeBreakdown`), carried by `extraApplicationFeeCents` (the field built for the vendor take rate). PropLane's net = fee - Stripe cost; never negative by construction (fee >= 0, processing component is the existing pass-through). |
| `on_behalf_of` | Changes settlement merchant, statement descriptor, fee schedule. | **Not used**, same as every other destination charge in the app (PropLane stays merchant of record; one statement descriptor; same-region only). |
| Refund | Default: destination keeps the money, platform covers it. `reverse_transfer: true` pulls it back; a partial refund reverses a proportional share; `refund_application_fee: true` returns a **proportional** part of the application fee to the connected account (requires `reverse_transfer`). | Owner-routed refunds always send `reverse_transfer: true` + `refund_application_fee: true`: refunded rent un-collects the management fee in proportion (`feeRefundCents` below mirrors Stripe's proportional rounding and is reconciled against the refund's own application-fee refund). |
| Dispute | Platform is liable; Stripe debits amount + dispute fee from the platform. Recover by creating a **transfer reversal** (Dashboard or `transfers.createReversal`); if the connected account goes negative Stripe may debit its bank when `debit_negative_balances`. A won dispute can be re-transferred. | `charge.dispute.created` -> allocation `disputed`, manager alerted, no money moved yet. `charge.dispute.closed` lost -> one `transfers.createReversal` for the owner's transferred share with `refund_application_fee: true` (both sides made whole except Stripe's dispute fee, absorbed by PropLane and booked as a platform cost, not charged to the owner); won -> allocation back to `settled`, nothing to re-transfer (we reverse only after a loss). Idempotency key `owner-dispute-reversal:<dispute id>`. The accounts are application-controlled (`losses.payments: application`), so PropLane is responsible for negative balances. |
| Async ACH | Transfer sits in the connected account's pending balance; if the debit fails Stripe **reverses the transfer itself**. Transfer can also be skipped when the account loses capability (`charge.updated` with `transfer_data` null). | Allocation is created only after the Charge is `succeeded` and the transfer legs hydrate. A skipped transfer fails the attestation (`DestinationSourcePendingError` retry then "needs source review"), so rent is never marked allocated to an owner who did not get it. |
| Account debits | Only where PropLane is responsible for negative balances, **requires legally binding consent from the connected account**, extra cost, same region, <= $100,000, and a debit can not push the balance negative without reserves. | **Not used.** Expenses are recouped by netting (next row). Debits stay a documented option for the counsel/consent step. |
| Separate charges and transfers | Charge on platform, `transfers.create` later (optionally `source_transaction`); refunds do NOT touch transfers (platform reconciles). | Not used for rent (would put funds on the platform balance = holding owner money). Reserved for the "pay owner" fallback below. |

## The two routing cases

```
resident pays rent on house H  ->  resolveOwnerRentRouting(H, cart, method)
  no ACTIVE agreement on H                  -> { kind: "none" }              today's flow, untouched
  active agreement, owner payout-ready      -> { kind: "owner_destination" } destination charge to owner,
                                               application_fee = management fee (+ processing + expense recoup)
  active agreement, owner NOT ready         -> { kind: "held" }              today's workspace flow; allocation
                                               row `routing=held` records what the owner is owed; manager alerted
  agreement expired/ended/draft             -> { kind: "none" }
  cart mixes routed and unrouted kinds      -> refuse (MIXED_OWNER_ROUTING)
  autopay on an owner-routed house          -> refuse, resident pays by hand (follow-up; see Not done)
```

`held` money lives in the manager's own balance exactly as today (workspace flow); the owner's share is a payable on the
owner ledger. It is settled by the existing **manual owner distribution** (`manager_owner_distributions`:
draft -> approved -> paid, GL-posted) or disappears from `held` automatically when the owner becomes payout-ready and the
manager pays the distribution. There is no PropLane-balance-to-owner Stripe transfer in this build (the balance spend
rail is classified-source arithmetic that deserves its own review).

## Fee model (`src/lib/owner-management/fee-math.ts`, pure, integer cents)

Agreement fields: `fee_model` = `percent_of_collected` | `flat_monthly`; `fee_bps` (percent), `fee_flat_cents`;
`leasing_fee_bps` (percent of a lease's first routed payment, once per resident + house); `min_fee_cents` (monthly floor);
caps in code: percent <= 30%, flat <= $5,000, leasing <= 100%.

Fees are computed on the **month's cumulative collected principal** (Pacific month of the payment), so partial payments,
split carts and retries can never over- or under-collect by a cent:

```
targetFee(cumPrincipal) =
  percent_of_collected: round_half_up(cumPrincipal * fee_bps / 10000)
  flat_monthly:         min(fee_flat_cents, cumPrincipal)
  then:                 max(that, min(min_fee_cents, cumPrincipal))
thisPaymentFee = clamp(targetFee(cumAfter) - feeTakenBefore, 0, thisPaymentPrincipal)
leasingFee     = first routed payment of a lease only: round_half_up(principal * leasing_fee_bps / 10000)
managementFee  = thisPaymentFee + leasingFee            (<= principal; the destination always nets > 0)
ownerNet       = principal - managementFee - ownerBornProcessingFee - expenseRecoup
```

`feeTakenBefore` / `cumBefore` come from the month's allocation rows plus live reservations, net of refunds. Two checkouts
racing for the same agreement/month serialize on `reserve_owner_fee` (SQL, row-locked on the agreement): the caller passes
what it saw; if another reservation landed first the RPC answers `conflict` and the caller recomputes (3 tries, then 409
"try again"). The RPC also enforces the hard bounds regardless of what the caller computed: `fee <= principal`, month
cumulative fee <= the model's maximum for the month's cumulative principal (+ leasing), recoup <= outstanding approved expense.
A failed/expired attempt releases its reservation.

Refund of `r` cents on a payment of `p` cents with fee `f`: `feeRefund = round_half_up(f * r / p)` (full refund returns
exactly `f`), `ownerReversal = r - feeRefund`. A partial refund then re-runs the month target on the next payment, so the
fee converges on the net collected.

## Checkout integration (what changes in the hardened rail, and what does not)

The resident checkout keeps its claim machinery untouched: `reserve_resident_checkout_attempt` (destination-agnostic in SQL),
frozen `provider_params`, `settle_resident_checkout_attempt`, refund evidence, the cross-rail double-pay trigger. Changes are
**additive branches keyed on `metadata.owner_routing_v = "1"`**:

- `createHouseholdChargeCheckout` / the manual-ACH PaymentIntent: after the fee payer is resolved, call
  `resolveOwnerRentRouting`; for `owner_destination` set `destinationAccountId`, `extraApplicationFeeCents`, metadata
  `owner_routing_v, owner_agreement_id, owner_user_id, owner_destination_account, owner_mgmt_fee_cents, owner_recoup_cents`,
  and **omit** `platform_hold`; reserve the fee (`reserve_owner_fee`) before the provider call.
- `assertResidentCheckoutAttemptTerms` / `assertResidentCheckoutSession` / the manual-ACH loader: allow a destination
  only when every owner field reconciles with `provider_params` (destination, fee, agreement id), otherwise the old
  "no destination" rejection stands.
- Settlement (`settleClaimedHouseholdCart`, `markHouseholdChargePaidFromStripeSession`): the fresh-source check branches to
  `assertFreshOwnerDestinationSource` (PaymentIntent has the exact destination and fee, Charge succeeded and unrefunded).
- Crediting (`creditVerifiedHouseholdCheckoutSource`): branches to `creditVerifiedOwnerDestinationSource`, which
  attests the destination legs, writes the allocation (idempotent), settles the fee reservation, posts the ledger/GL and
  stamps the manager's `ledger_entries` row. **No `platform_payment_holds` row is created** (nothing to hold).
- Refund rail: `resolveHouseholdChargeRefundRail` sees an owner allocation and returns `{ rail: "owner_destination" }`; the
  refund is `reverse_transfer + refund_application_fee`.

## Data model (migration `20261018270000_owner_management.sql`, additive, RLS on, service_role only)

| Table | Purpose |
| --- | --- |
| `owner_management_agreements` | One per house per period. Fee terms, owner, threshold, reserve target, signature (`signed_at`, `signed_by_user_id`, `terms_sha256`, `terms_snapshot`), status `draft` / `active` / `ended`. Unique partial index: one `active` per property. |
| `owner_fee_reservations` | One per checkout attempt: principal, mgmt fee, leasing fee, expense recoup, month key; `reserved` -> `settled` / `released`. Source of truth for in-flight fee math. Unique on attempt token. |
| `owner_rent_allocations` | One per settled routed (or `held`) rent payment component: gross principal, processing fee (owner-borne), mgmt fee, recoup, owner net, Stripe ids, running refunded/disputed amounts, status. Unique `(stripe_payment_intent_id, charge_id)`. |
| `owner_allocation_events` | Idempotency log of every refund / dispute / reversal / payout applied to an allocation, unique `(kind, stripe_object_id)`. |
| `owner_expenses` | A vendor bill on a managed house awaiting / past owner approval, recoup state. Unique `(source_type, source_id)`. |
| `owner_statements` | One row per owner + house + Pacific month: frozen totals, PDF object path, `emailed_at`, `texted_at`. Unique key makes the monthly job idempotent. |

All classified in `account-purge-manifest.ts`.

## Agreement lifecycle and signing

`draft` (manager edits terms) -> **Send for signature** (stamps `sent_at`, emails and texts the owner a sign-in link to
`/portal/owner/agreements/<id>`) -> owner **Signs in the portal** (authenticated, `property_owner` membership checked
fresh) -> `active` with `signed_at`, `signed_by_user_id`, `terms_sha256` of the canonical terms the owner actually saw
(same discipline as lease execution: the hash is of the document that party saw, the signed terms are immutable; to change
fees the manager ends the agreement and drafts a new one). Only the property's workspace owner or an admin may create,
send, end; nobody but the named owner may sign. Ending sets `ends_on` and stops routing for NEW charges; in-flight
checkouts already reserved settle on their frozen terms.
The texted link is a plain portal sign-in deep link (`portalSignInHref`), not a phone-bound link: the phone-bound link
purposes are a fixed contract (`PHONE_BOUND_LINK_POLICY`) and identity here is the logged-in owner, which is stronger.

## Expenses and repair approvals

A vendor bill/service charge on a managed house creates an `owner_expenses` row. Amount <= `repair_approval_threshold_cents`
-> `auto_approved` (listed on the statement). Above it -> `pending_owner` and ONE text goes to the owner's verified phone:
`Leak repair at 5259 Brooklyn, $240 from Mike's Plumbing. Approve? Y/N` (GSM-7, <= 160 chars where possible). The owner's
`Y` / `N` is matched on the shared line to the single open approval for that verified phone (more than one open: they must
name it or answer from the portal), re-checking membership, house grant and amount; the decision is stored once
(`decided_at`, `decided_via`). **Collection:** an approved expense is recouped by **netting against the owner's next routed
rent payments** (extra application fee, capped at 50% of that payment so the owner always receives most of it, remainder
rolls to the next payment), reserved with the fee. Fallbacks, in order: (1) netting (built), (2) manager marks it collected
outside PropLane (built), (3) charge the owner's card on file (not built), (4) Connect account debit (not built; needs the
owner's legally binding debit consent, extra Stripe cost, same-region only, per the docs above). A declined repair is not
recouped and is shown to the manager.

## Ledger and reconciliation

Every allocation posts once, keyed `owner-split:<allocation id>` (GL `owner_distribution` source: DR `owners_equity` /
CR `operating_cash` for the owner net actually transferred); refunds and reversals post `owner-split-reversal:<event id>`.
The manager's existing `ledger_entries` payment row is untouched (it records the rent paid). The management fee is the part
of cash PropLane keeps (the application fee) - it is not a second journal line. The statement and the ledger can therefore
never disagree: `reconcileOwnerAllocations` (daily cron `/api/cron/owner-management`) proves, per house and month,
`sum(allocation principal) - refunds == ledger payment total for routed charges`, `principal - fee - processing - recoup ==
owner net`, and spot-checks the newest allocations against Stripe (transfer exists, amount matches). A mismatch is recorded
in `owner_allocation_events` as `reconcile_flag` and surfaces on the admin events list; nothing is auto-corrected.

## Monthly owner statement (Pacific, the 1st)

`/api/cron/owner-management` (hourly; acts only when the Pacific date is the 1st and a statement for the previous month is
missing) builds, per owner + house: rent collected, management fee, leasing fee, expenses (auto-approved + approved),
processing fees borne, net paid to owner, held/owed, occupancy (rooms occupied / total), known upcoming costs (approved
bills due), reserve target. Totals are computed from allocations (never a second formula) and frozen in `owner_statements`.
PDF through the existing `buildOwnerStatementPdf` path (now carrying the real management fee), emailed from the workspace
work email and summarized by one text from the shared line. Owners read past statements in `/portal/owner/statements`.
`queryOwnerStatement` now returns the real management fee (it was a hard-coded 0 by captain decision until a fee model
landed; this is that landing), so Profitability and the formal export agree.

## Owner on the PropLane line

The router's `team_member` lane intentionally excludes owners (`withoutOwnerLinks`) and the role/reason contracts are
fixed, so owners are handled by a **pre-routing owner lane** in the shared-line seam (`owner-line.server.ts`): a verified
phone that belongs to an owner membership and matches an owner intent (house status / "how's my house doing", "statement",
Y or N with an open approval, "help") is answered there; anything else falls through to normal routing unchanged. Read-only
data comes from typed functions scoped to the owner's granted houses (`ownerHouseStatus`, `ownerMonthSummary`,
`ownerOpenApprovals`) built on `loadOwnerGrants`; no model arithmetic, no manager tools, no cross-owner data. The only write
is the approval decision, which re-derives the owner from the phone and the house grant.

## Owner conveniences built

1. Monthly statement by email + text + portal, with occupancy and upcoming costs.
2. Repair approvals by Y/N with a per-agreement threshold; **one-tap "approve all routine repairs under $X"** (sets the
   threshold from the portal).
3. Reserve target on the agreement, shown with the month's net so the owner can see what to set aside (PropLane does not
   hold it).
4. Year-end tax package: per house, Schedule E-ready totals (rents received, management fees, repairs, other expenses)
   from the allocations and approved expenses, plus the vendor 1099 list from existing vendor tax profiles.
5. Occupancy and vacancy numbers on the statement and in the text answer.

Listed, not built (needs product input, would need new tables or integrations): document vault with insurance/permit expiry
reminders (the Documents module already shares files with owners, expiry reminders exist at `send-document-expiration-reminders`
and should be pointed at owner-shared documents), maintenance history with photos, rent-and-vacancy recommendations from live
market data, annual inspection report link, owner card-on-file expense collection, per-house owner payout schedule and
instant payouts, owner reimbursement via account debit (consent).

## Legal and compliance flag (read before any production use)

**Washington RCW 18.85 (real estate brokerage / property management licensing) and trust-account rules apply to a business
that manages rental property for others and handles tenant money.** Routing rent straight to the owner's connected account
avoids PropLane holding rent, but it does not by itself answer whether PropLane (or a PropLane Service workspace) needs a
managing broker license, a trust account for security deposits (RCW 59.18.270 - deposits stay in the workspace trust flow
here, not routed), written management agreements with required disclosures, or 1099-K / 1099-MISC handling for owners.
Counsel must review the agreement text, the fee disclosures, and the licensing posture per state before the first live
agreement. Nothing here has been run against live Stripe; the production rollout (flag, Stripe live Connect onboarding,
migration to staging/production) is a human step (decision #10).

## Files

`src/lib/owner-management/`: `fee-math.ts`, `routing.ts`, `agreements.server.ts`, `checkout-routing.server.ts`,
`destination-credit.server.ts`, `adjustments.server.ts`, `expenses.server.ts`, `statements.server.ts`, `owner-line.server.ts`,
`reconcile.server.ts`, `tax-package.server.ts`. Routes under `src/app/api/portal/owner-management/*`,
`src/app/api/owner/agreements/*`, `src/app/api/cron/owner-management/route.ts`. Tests `tests/unit/owner-management-*.test.ts`.
