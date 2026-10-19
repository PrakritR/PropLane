# Owner management: PropLane-held funds, per-party balances, owner and vendor withdrawals

Authoritative for this feature. Lane `on/owners` (W17, one-number build). **Money + authorization: Stripe TEST mode only
while building; dev/test database only; never staging or production; agents never run production steps (decision #10).**

Captain (Oct 18 2026): *"owners paid for our management services effectively ... a split payout ... a payout system where we
can transfer some money to property owner"* and, later, the redesign this doc implements: *"there will be a new workspace per
property owner we sign ... owner can withdraw appropriate amount per each workspace, be able to set fee. say rent is $1000, can
set payment to property owner to be 90% of rent and proplane take 10%. property owner has finance section they can see our cut
and how much they get. they can see any billings we would do for maintenance vendors etc that get cut from their end. they can
see their total bank statement and withdraw to their personal bank account. we will keep money in our proplane stripe account.
implement same money tracking for vendors and think of a way to pay vendors efficiently."*

This **replaces** the first design (a destination charge to the owner's Connect account with the fee as `application_fee_amount`).
That design is gone: no destination, no application fee, none of its plumbing is in the resident-payment rail.

## Scope

| Workspace | Money model |
| --- | --- |
| **PropLane-managed** (has an active `managed_workspace_fee_policies` row; one workspace per signed owner / client / city) | Resident money is captured on PropLane's platform Stripe balance (central capture, unchanged) and **never** credited to a manager hold. It is allocated in the **party ledger**: owner payable, PropLane fee revenue, vendor payables. Owners and vendors withdraw their available balance to their own Express account. |
| **Self-serve software workspace** (no policy) | Byte for byte today's per-workspace Stripe Connect flow (hold credited to the manager, manual payouts, vendors paid from the workspace's own balance). Nothing in this doc touches it. |

Managed-ness is read from the database at the moment money is credited (the property's `workspace_id` -> active policy), never
from a request. A workspace with no policy is not managed.

## Invariants

1. **The ledger is the source of truth.** Every money event posts exactly one balanced journal (`party_ledger_journals` +
   `party_ledger_lines`, signed cents, debit positive, credit negative, a deferred constraint makes every journal sum to 0).
   The idempotency key of a journal is derived from the Stripe object id (or source row id) plus the event type, so a webhook
   replay is a no-op and a conflicting replay (same key, different payload) raises.
2. **A party never has more than they are owed.** Withdrawals are reserved inside one database function under a per-party
   lock, against the ledger's `available` figure, one in flight at a time per party. Stripe is only asked after the
   reservation; a failed transfer reverses it. Before every transfer the platform's own Stripe available balance is checked and
   a disagreement refuses the withdrawal.
3. **Cents are integers; the fee rounds down, the owner gets the remainder** (`fee = floor(distributable * fee_bps / 10000)`
   on the month's cumulative figure, so partial payments sum to exactly one floor). A refund reverses the owner/fee split
   pro rata (a full refund reverses it exactly).
4. **Ownership is re-derived at every write.** The workspace comes from the property record, the owner of record from the
   policy, the vendor from the stored work order, the withdrawing person from the session. A body id is never authority.
5. **Deposits are not income.** Security / holding deposits are credited to `tenant_deposit_liability` (trust-style, not
   withdrawable, refundable) and never split.
6. **Fail closed.** A managed capture that cannot be allocated throws, so Stripe redelivers; it is never credited to a
   manager hold as a fallback.
7. **No flag changes behaviour for non-managed workspaces.** Code that reads a new table treats 42P01 / 42703 / PGRST205 as "not
   managed / nothing there" (production runs code before migrations).

8. **A PropLane-managed workspace is view-only for its client.** `portal_workspaces.is_service` + owner = client, no
   SELF-PAID plan (a Stripe subscription id, monthly/annual billing or an Apple anchor; admin grants, trials and waivers do
   not count), and the client is neither a platform admin nor the platform service owner. The rule is
   `public.managed_read_only_workspace_ids()` (migration `20261019100000`), mirrored in
   `src/lib/auth/managed-read-only.server.ts`; it also locks an accepted `property_owner` seat. Enforced in the middleware
   (non-allowlisted `/api/*` writes: `403 read_only_managed`, a failed lookup `503`; allowlist in
   `managed-read-only-policy.ts`), `scopeManagerTool` (every write tool), `/api/portal-inbox-threads` (Team chat and the
   Assistant thread only), `/api/workspaces` (rename/delete/move) and `resolveWorkspaceFromSettingsRequest`. The seated
   admin member and platform staff keep write. Never hide it in the UI alone; deploy the migration BEFORE the code (a
   missing function refuses every non-allowlisted write).

## Stripe model (docs.stripe.com, read Oct 18 2026)

Separate charges and transfers. The charge is created on the platform account (no `transfer_data`); funds sit in the platform
balance; PropLane later creates a **Transfer** to the connected account (`transfers.create`, idempotency key per withdrawal) and the
connected account's balance is paid out to the bank (a **Payout** on the connected account).

| Topic | Fact | What we do |
| --- | --- | --- |
| Balance timing | A charge's funds are `pending` until the balance transaction's `available_on`. A transfer needs available platform balance (or `source_transaction`). | Each ledger credit carries `available_on` from the charge's balance transaction (`verifiedCapturedChargeAvailability`). `available to withdraw` only counts matured credits, then we re-check `balance.retrieve().available` before every transfer. |
| Transfers | `transfers.create({ amount, currency, destination, transfer_group, metadata }, { idempotencyKey })`. Reversible with `transfers.createReversal`. Refunds of the original charge do **not** touch transfers. | One transfer per withdrawal, key `party-withdrawal:<id>`. A refund of rent is paid from platform balance and reverses the owner's *ledger* share (owner balance can go negative; recovered from the next rent). |
| Express accounts | Our accounts are application-controlled (`losses.payments: application`, manual payout schedule). Payout readiness = `resolvePayoutsReadiness`. | Withdraw requires the person's own ready Express account whose `metadata.axis_user_id` is that person. Payout to the bank follows the transfer (`payouts.create`, key per withdrawal), best effort; the transfer is the money event. |
| Disputes | Platform is liable for amount and dispute fee. | `charge.dispute.created` freezes the owner's share (`dispute_hold`); won returns it; lost writes it off (owner and fee pro rata) and books the dispute fee as a PropLane expense. |
| Account debits | Need legally binding consent from the connected account, extra Stripe cost, same region. | Not used. Negative owner balances are recovered by netting the next rent. |
| Async ACH | If the debit fails Stripe reverses automatically; a failed payment never reaches `rent_capture`. | The ledger posts only after the existing claim machinery marks the charge paid and the Charge is `succeeded`. |

## Ledger

Accounts (`party_ledger_lines.account`), balance sign in parentheses:

| Account | Party key | Meaning |
| --- | --- | --- |
| `platform_cash` | none | PropLane's Stripe platform balance attributable to managed money (debit). |
| `owner_payable` | `owner:<user id>` + workspace | What PropLane owes the owner for that workspace (credit). |
| `vendor_payable` | `vendor:<user id>` (or `vendor_dir:<directory id>` until the vendor has an account) | What PropLane owes a vendor across all managed workspaces (credit). |
| `proplane_fee_revenue` | workspace | PropLane's cut (credit). |
| `processing_recovery` | workspace | The resident-added / owner-borne processing fee that pays Stripe's cost (credit). |
| `tenant_deposit_liability` | workspace | Deposits held for residents (credit). |
| `withdrawal_in_flight` | party | Reserved by a withdrawal until the transfer lands (credit). |
| `dispute_hold` | owner + workspace | Owner share frozen by an open dispute (credit). |
| `platform_dispute_expense` | none | Stripe dispute fees PropLane absorbs (debit). |

Journals:

```
rent_capture    DR platform_cash gross | CR owner_payable owner share (available_on) | CR proplane_fee_revenue fee
                | CR processing_recovery (gross - distributable) | CR tenant_deposit_liability deposits
refund          DR owner_payable owner part | DR proplane_fee_revenue fee part | (DR tenant_deposit_liability) | CR platform_cash refund
dispute_opened  DR owner_payable owner part | CR dispute_hold          dispute_won reverses it
dispute_lost    DR dispute_hold | DR proplane_fee_revenue | DR processing_recovery | DR platform_dispute_expense fee | CR platform_cash amount + fee
vendor_bill     DR owner_payable amount | CR vendor_payable amount      (managed workspace pays the vendor)
withdrawal      reserve: DR payable | CR withdrawal_in_flight;  complete: DR withdrawal_in_flight | CR platform_cash;  failed: reverse the reserve
```

`available(party)` = matured credits minus all debits, never more than `owed`, minus the owner's reserve target. `pending` =
owed minus matured. `owed` = -sum(lines). The processing fee is never refunded (as today).

Daily reconciliation (`/api/cron/owner-management`, extends the pattern of `reconcile-proplane-balance`): (1) every journal sums
to 0; (2) `platform_cash` equals receipts - refunds - dispute losses - completed withdrawals; (3) sum of payables + revenue +
deposit liability + processing recovery + in-flight + dispute hold - dispute expense == `platform_cash` (the whole ledger nets to
zero by construction, so this checks nothing was posted outside a journal); (4) the Stripe platform `available + pending`
balance >= `platform_cash` (the managed money is actually there); (5) each recent capture's gross equals the Charge amount at
Stripe. A failure records an `owner_ledger_flags` row and alerts admin; it never auto-corrects.

## Fee policy (`managed_workspace_fee_policies`)

One *active* row per workspace (`owner_share_bps` default 9000 = owner 90 / PropLane 10, `applies_to` rent | all, `leasing_fee_bps`
of the first month, `min_fee_cents` per month, `reserve_target_cents`, `repair_approval_threshold_cents`, `effective_from`).
History is kept: editing a signed policy is not possible (trigger); a change is a new draft version that, once accepted,
ends the previous one. The owner of record (`owner_user_id`) accepts it by signing in to the Property portal (Finances › Owner payouts), or an admin records an
offline signed contract (`accepted_via = admin_attested`, with a note). Only an accepted policy makes a workspace managed.
Only a platform admin sets or ends a policy (the fee is PropLane's revenue). Rounding, odd amounts, partial payments, minimum and
leasing fees: `src/lib/owner-management/fee-math.ts`, tested.

## Vendors

A managed workspace's vendor bill (approved work-order / invoice cost, tour host fee, cleaning) posts `vendor_bill`: the vendor
is owed, the owner is charged, with the job, vendor and date on the owner's statement. PropLane fronts it: nothing moves at Stripe
until the vendor withdraws, and an owner balance that goes negative is recovered from the next rent. A bill above the owner's
repair threshold waits for the owner's Y/N (text) or portal approval before it posts. A vendor on a managed workspace is paid
with one Stripe transfer per withdrawal or per **weekly batch** (`/api/cron/owner-management`, Mondays Pacific, one transfer per
vendor with at least $25 available, key `vendor-batch:<vendor>:<ISO week>`), not per job. Self-serve workspaces keep paying
vendors from their own balance through the existing rails.

## Owner experience

Finances › Owner payouts in the Property portal, `/portal/financials/owner-payouts` (owner of record of a managed workspace; the tab is hidden on a 403): Balance, Available to withdraw, Pending, History; statement by
period (rent collected gross, PropLane fee, vendor charges each with job link, refunds and adjustments, net to owner,
withdrawals, ending balance), PDF through the existing PDF path, Withdraw. Monthly statement on the 1st (Pacific) by email and
text. On the PropLane line: "how's my house", "balance", "statement", Y/N repair approvals (pre-routing owner lane in the
shared-line seam; read-only typed functions scoped to the owner's workspace; the only write is the approval decision).
Vendor Finances (`/vendor/financials`): the same balance / withdraw / history per vendor across managed workspaces. Admin (Property
management half): platform cash, owed to owners, owed to vendors, fee revenue by workspace and month, reconciliation status.

## Dev proof (Stripe TEST mode, dev database)

`NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/prove-managed-finance.ts` refuses to run unless the
Stripe key is a test key and the Supabase project is the dev/test one. It creates its own workspace, users, property, fee policy
and two test Express accounts, then drives real Stripe test objects through the real library code: a platform charge (no
destination), the allocation and its replay, a partial refund, a vendor bill, an owner withdrawal and a vendor withdrawal (real
Transfers and Payouts to the Express accounts), a repeated click, an over-large and a foreign withdrawal, a real Stripe test
dispute opened and lost, and the daily reconciliation. Last run: 21 checks, all passing. Not exercised end to end: the resident
Checkout / webhook claim machinery (covered by unit tests with the same Checkout shapes), and emails (the dev Resend domain is not
verified).

## Ease-of-life items built / listed

Built: monthly statement (email + text + portal), repair approval threshold with one-tap "approve routine repairs under $X",
reserve target shown against available, year-end tax package (Schedule E-ready totals per workspace from the ledger plus vendor
1099 totals), occupancy on the statement. Also built: `POST /api/portal/managed-finance/vendor-charge` (a manager or admin charges the owner for a vendor outside a service
record, for example a tour host fee or a cleaning; idempotent on a client key, same owner-approval gate).
Listed, not built: document vault with expiry reminders, maintenance history with photos,
rent / vacancy recommendations from market data, annual inspection link, owner card-on-file expense collection, per-owner payout
schedule and instant payouts, trust-account adoption (see below), application and linked-form fees on managed workspaces (they
still follow the manager-hold path), tour-host / cleaning fee triggers beyond the generic vendor-charge API, autopay-specific tests.

## Legal and compliance flag (read before any production use)

**Holding owners' rent is regulated.** Washington RCW 18.85 (real estate brokerage and property management licensing) and
WAC 308-124E (trust accounts, record keeping) apply to a firm that manages rental property for others and handles client funds;
a security deposit has its own trust rule (RCW 59.18.270). Money in PropLane's platform Stripe balance is commingled at the
bank, so the ledger keeps each owner's funds segregated per workspace and deposits separate, so a licensed trust account (or a
Stripe-supported funds-segregation arrangement) can be adopted without redesign. Counsel must review the licensing posture, the
management agreement and fee disclosures, 1099-K / 1099-MISC handling, and money-transmission analysis **before the first outside
owner**. Nothing here has run against live Stripe; production rollout, live Connect onboarding and the migration to
staging / production are human steps.

## Files

`src/lib/owner-management/` (policies, fee math, statements, owner texting, expenses), `src/lib/managed-finance/` (party ledger,
capture crediting, refunds, disputes, vendor bills, balances, withdrawals, reconciliation). Routes: `/api/portal/owner-management/*`
(admin / workspace), `/api/owner/*` (owner), `/api/vendor/managed-finance/*`, `/api/cron/owner-management`. Migration
`supabase/migrations/20261018270000_owner_management.sql`. Tests `tests/unit/owner-management-*.test.ts`, `tests/unit/managed-finance-*.test.ts`.

## Withdrawal idempotency and hand-posted vendor charges

- A manual withdrawal's stored key is bound to (client key, party, workspace, amount) in `withdrawalKey`; a weekly batch key is server-made and amount-free. When `reserve_party_withdrawal` answers `exists`, only the STORED amount, party and destination decide: a mismatch is a 409 (`KEY_REUSED`) with no Stripe call, a completed row returns its stored transfer, and a reservation older than 20h (or `unknown`) is left to `reconcileWithdrawals`, never re-sent. The Stripe transfer key carries the withdrawal id, party and amount. Reconcile flags (never fails) a reservation when any transfer sits in its group without matching it.
- `POST /api/portal/managed-finance/vendor-charge` needs a target holding the vendor role in `profile_roles`, on the workspace manager's `manager_vendor_records` roster, and not the caller. Auto-approved bills per workspace are capped at 4 repair thresholds per 24h; past it the owner is asked.
