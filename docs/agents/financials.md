> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Charge receipt authority (payment audit)

The ordinary `/api/portal-household-charges` full-list mirror carries charge edits only. It cannot create `paid`/processing/refunded status, provider or receipt fields, or waiver audit fields. Existing financial rows are immutable through that mirror. Writes to known rows compare stored status and `updated_at`; new IDs insert only, and only rows actually persisted reach reminder/ledger sync. If a later row in the same mirror fails, earlier persisted rows still sync before the request returns an error. A manager's offline receipt uses only `action: "recordOfflinePayment"`, which rechecks owner, workspace, status, and the stored amount before ledger posting.

`unmarkPaid` refuses settled or ambiguous receipts with 409 while there is no accounting-safe reversal; Payments offers no Undo or Move to pending on a recorded charge. Returning a service photo never marks its charge paid. The currently unused short-to-long application-fee projection cancels a clean unpaid obligation without a paid date or provider source, preserves any actual receipt or in-flight source, and does not mint a server waiver audit. A new Checkout cannot begin when a same-manager/property/resident legacy paid fee lacks application identity. The manager application detail receipt is read from the exact application's owned claim, charge and ledger source; a current listing quote never proves payment, and a failed read never appears as “Not received.”

# Financials Phase 0: chart of accounts + write-through ledger

**`public.chart_of_accounts` is the runtime source of truth for account
labels/Schedule E lookups** (`src/lib/reports/chart-of-accounts-store.ts`,
seeded/extended in `supabase/migrations/20260710090000_chart_of_accounts_double_entry.sql`
with account numbers, `normal_balance`, asset/liability/equity types, and trust-bank
placeholders). `SYSTEM_CHART_ACCOUNTS` in `src/lib/reports/categories.ts` is a
defense-in-depth fallback (used when the DB read fails) plus the source for the
income/expense dropdown pickers — never add a code to one without the other.
Report-query functions that loop rows calling `chartAccountLabel`/`chartAccountScheduleE`
must `await primeSystemChartOfAccounts(db)` once up top; the store caches with a 5-min TTL.

**The ledger is write-through only — there is no read-time backfill.** The old
per-request `?backfill=1` repair pass on every report load was removed (it re-scanned
up to 2000 charges per page view — the exact Supabase-egress problem this file warns
about). Every server-side path that creates a charge or marks one paid MUST call
`syncLedgerChargeEntry`/`syncLedgerPaymentEntry` (`src/lib/reports/ledger-sync.ts`)
next to the DB write, or the row silently never reaches reports. Current call sites:
`/api/portal-household-charges` (client mirror upsert — via the batched
`syncDedupedCharges` wrapper), the late-fee creation in
`/api/cron/send-payment-reminders`, `stripe-household-charge.ts`, and
`stripe-application-fee.ts` — copy that pattern for any new charge-mutation route.
The Stripe paid paths are self-healing: `markHouseholdChargePaidFromStripeSession`
and `markApplicationFeePaidFromStripeSession` re-run `syncLedgerPaymentEntry` even
on their already-paid short-circuit (best-effort — a failure is logged, never
thrown), so a success-page retry or webhook redelivery repairs a ledger row whose
first sync failed transiently. Phase 2 webhook work builds on these paths — keep
that idempotent re-sync in place. Re-syncs rebuild the ledger row from the charge,
which usually carries no session id, so both update paths (`upsertLedgerEntryRow`
and the batched `syncDedupedCharges`) coalesce `stripe_checkout_session_id` to the
already-stored value — never let a re-sync blank it; it is the only link back to
the Stripe Checkout session that settled the payment
(regression coverage: `tests/unit/reports/ledger-sync.test.ts`).
**Offline receipts** use `POST /api/portal-household-charges` with
`action: "recordOfflinePayment"`, charge id, receipt date, method and note only.
The server re-reads the charge, checks owner/co-manager and active workspace,
preserves its stored amount, and compares status + `updated_at` before marking
paid. It awaits `syncLedgerPaymentEntry` before returning success; the same
receipt can retry an interrupted ledger write. Processing and partially paid
charges are refused by this full-receipt path. The client applies the returned
charge only after success, without sending a replacement snapshot.

**Deleting a charge deletes its ledger line — and only that line.**
`deleteLedgerEntriesForCharge` (`ledger-sync.ts`) removes the `entry_type = "charge"`
`ledger_entries` row with that `source_charge_id`, never its `payment` / `refund`
lines (money that actually moved stays on the books). The `deleteCharge` action in
`/api/portal-household-charges` calls it right after the charge row delete, scoped to
the charge's owner (or the calling non-admin manager when the row is already gone), or
income/delinquency reports keep reading a ledger row for a charge no one can see any
more. Coverage: `tests/unit/household-charge-delete-ledger.test.ts`.
The batched sweep logic (`backfillLedgerFromCharges` in `ledger-sync.ts`) still exists,
but only as an explicit, admin-gated, one-time historical repair — it is invoked solely
via `POST /api/admin/backfill-ledger` (optionally scoped to one `managerUserId` in the
body, which must be a uuid — anything else is rejected with 400), never from a report
route or page load. Run it once per environment after
deploying write-through sync to mirror any charge history that predates it.

**`security_deposit` charges book to `security_deposit_liability` (a liability), not
income**; `move_in_fee` stays income (non-refundable). The `nsf_fee` charge kind exists
in types/mappings only — nothing creates it until the Stripe-webhook phase. The deposit
liability sub-ledger, GL posting, and historical reclassification are Phase 3
(`/Users/prakrit/.claude/plans/idempotent-seeking-hopcroft.md` §1.8/§5) — Phase 0 only
stops new deposits from miscategorizing. `queryIncomeStatement` still sums all payment
ledger entries, so a paid deposit shows as a visible "Security Deposits Held" line until
Phase 3 excludes non-income accounts properly.

# Financials Phase 1: double-entry GL

**Additive layer on top of `ledger_entries` / `manager_expense_entries`** — existing income-statement/delinquency queries are unchanged; Balance Sheet / Trial Balance / General Ledger read the new GL tables.

**Schema** — `supabase/migrations/20260712090000_gl_journal.sql`: `gl_journal_entries` (source_type + source_id idempotency key) + `gl_journal_lines` (account_code, debit_cents, credit_cents). `ledger_entries.gl_journal_entry_id` links cash-event rows to their journal.

**Posting** — `src/lib/reports/gl-posting.ts`: idempotent `postGlChargeEntry` (DR AR / CR income or liability), `postGlPaymentEntry` (DR operating or trust cash / CR AR), `postGlExpenseEntry` (DR expense / CR operating cash). Wired next to `syncLedgerChargeEntry`/`syncLedgerPaymentEntry` in `ledger-sync.ts`, `/api/expenses` POST, and `createExpensesFromWorkOrder`.

**Reports** — `src/lib/reports/queries/gl-reports.ts`: `queryTrialBalance`, `queryBalanceSheet`, `queryGeneralLedger`, `queryCashFlowStatement` (simplified bank-account view). Registered in `MANAGER_REPORT_IDS`, `runManagerReport`, Finances portal tabs, and `run_financial_report` AI tool.

Balance Sheet reads the same owner, property, and as-of GL totals as Trial Balance. It includes the signed balance of still-open income and expense accounts as one “Unclosed earnings” equity row; closing journals move that balance into posted equity, so closed nominal accounts add zero. A true GL imbalance remains visible rather than being plugged.

**Historical repair** — `POST /api/admin/backfill-gl` (admin-gated) sweeps existing ledger + expense rows through the posting service once per environment; never on page load.

**Deploy:** `npm run db:push` for `gl_journal_*` tables before GL posting will succeed in dev/staging/production.

# Financials Phase 2: Stripe webhook completeness

**Schema** — `supabase/migrations/20260712100000_stripe_payouts_disputes.sql`: `stripe_payouts` (Connect bank payouts), `stripe_disputes`, plus `profiles.stripe_connect_charges_enabled` / `stripe_connect_payouts_enabled` cache.

**Ledger fee capture** — `src/lib/stripe-ledger-fees.ts` populates `stripe_fee_cents`, `net_cents`, `axis_fee_cents`, `stripe_charge_id` on payment ledger rows after checkout. On a destination charge the manager's row carries `stripe_fee_cents = 0` and `net_cents = charge.amount − application_fee` (the destination transfer) — Stripe's fee is PropLane's, not the manager's. When Connect + bank is not ready, the same charge sits on the platform as a `platform_payment_holds` row and is transferred once identity + bank is ready (`account.updated`). See [`resident-payments.md`](resident-payments.md).

**Webhook handlers** — `src/lib/stripe-webhook-financials.ts` + extended `src/app/api/stripe/webhook/route.ts`:
- `account.updated` → Connect readiness on profiles + drain leftover `platform_payment_holds` when `connectAccountReadyForAchPayouts`
- `transfer.created` → `stripe_transfer_id` / `net_cents` on ledger
- `payout.paid` / `payout.failed` / `payout.canceled` → `stripe_payouts` (resolves manager via `profiles.stripe_connect_account_id`)
- `charge.refunded` / `refund.*` → refund ledger row + `postGlRefundEntry`
- `charge.dispute.*` → `stripe_disputes`
- `payment_intent.payment_failed` → metadata on charge row (does not change `HouseholdCharge.status` — NSF fee status is Phase 6)

**Reports** — `queryPayoutHistory` in `gl-reports.ts`; Finances **Payout history** tab + `run_financial_report` tool.

**Stripe Dashboard:** add events `transfer.created`, `payout.*`, `charge.refunded`, `refund.*`, `charge.dispute.*`, `payment_intent.payment_failed` to the webhook destination alongside existing checkout/subscription events.

## In-app payouts (PLAN-0920-0853, consolidated under PLAN-0920-1500)

**Profile → Payouts** (`/portal/profile?tab=payouts`, vendor twin under
`Vendor → Settings → Payouts`, `src/components/portal/portal-payouts-settings-page.tsx`)
is the payout settings UI — balance, Withdraw (Standard to a payable bank or
Instant to an eligible debit card), bank accounts, schedule and history.
The old manager Payments and vendor Financials payout tabs route to this page.
Stripe's Express Dashboard and Account Links are gone. Identity
verification for a **new** account is PropLane's own in-app form, driven by
`account.requirements.currently_due` (PLAN-0920-1500 Part C — see
[`stripe-connect-ach-setup.md`](../stripe-connect-ach-setup.md) for the full
model, the routes, and the test-mode identity values); a **legacy** account
keeps finishing through Stripe's embedded `account_onboarding` /
`account_management` components mounted inside PropLane's own modal.

- **Pure logic** — `src/lib/stripe-payouts.ts`: Instant fee (flat 1%, no
  floor — Stripe's Connect Instant Payouts pricing has no minimum fee, only a
  $0.50 minimum PAYOUT amount), Standard/Instant eligibility, arrival
  estimates, `settings.payouts.schedule` ↔ our schedule shape, next-payout-date,
  and the history row normaliser.
- **Platform hold (PLAN-0923-1041)** — `platform_payment_holds` plus
  `src/lib/stripe-platform-hold.ts` / `.server.ts`. A captured payment may
  remain physically held on the platform until its exact source is eligible
  for release. Release to Connect is a source movement, never a bank payout;
  a later Connect payout has its own history row. Withdraw never spends a
  hold. `availableCents` is a legacy combined display value; all withdrawal
  maxima use the signed Stripe `withdrawableCents` (clamped to zero for the
  action). The UI shows `heldCents`, `releasePendingCents`, provider deficit,
  and confirmed `onTheWayCents` separately. Manager recovery owed comes from
  succeeded funded debt less actual recovery; reserved recovery is a separate
  noncash fact and does not reduce that debt. A pending unreconciled in-app
  payout claim disables another withdrawal.
- **Stripe/DB reads and writes** — `src/lib/stripe-payouts.server.ts`:
  `readPayoutSnapshot` (balance, setup state from `account.requirements`,
  schedule, last-50 history, held vs withdrawable); the separate exact-owner
  bank list is the destination authority. An unknown or failed bank-list read
  disables money actions; a `new` bank can be payable when the provider says
  so. `createInAppPayout` claims a pending
  `stripe_payouts` row BEFORE calling Stripe — the same pattern as
  `payoutVendorForWorkOrder` (`src/lib/stripe-vendor-payout.ts`) — so a
  double-click loses the insert race on the partial unique index
  `stripe_payouts_pending_claim_unique` and gets a 409; `writePayoutSchedule`.
- **Instant amount semantics**: Stripe assesses its 1% Instant fee as a
  SEPARATE debit from the connected account's balance on top of whatever
  `amount` you request — it is not netted out of `amount` for you. To make
  "Bank receives $X" true, `createInAppPayout` requests the NET amount as
  the Stripe payout `amount`; the gross amount the user typed is what gets
  checked against `instant_available`, leaving room for both.
- **Schema** — `supabase/migrations/20260920200000_in_app_payouts.sql`:
  `stripe_payouts.stripe_payout_id` becomes nullable (the claim row has none
  yet), plus `method`, `vendor_user_id`, `initiated_in_app`,
  `destination_last4`, `fee_cents`, and a `returned` status (a `payout.failed`
  webhook with a bank-return failure code, surfaced distinctly from an
  ordinary failure). RLS is unchanged — `manager_user_id` already holds the
  vendor's own id for a vendor-initiated row (vendors and managers share the
  same `profiles.stripe_connect_account_id` column).
- A newly created Connect account defaults to **automatic weekly payouts
  (Friday)** (`createAxisConnectAccount` in `src/lib/stripe-connect.ts`); the
  in-app "Pay out" button works regardless of the schedule interval.
- **Identity verification** — `src/lib/stripe-connect-identity.server.ts`:
  `getIdentityRequirements` maps Stripe's `currently_due`/`past_due` to a
  typed field list (an unmapped key sets `fallbackToEmbedded`, never dropped
  silently); `submitIdentity` applies an `account_token`/`person_token` from
  the browser's Stripe.js `createToken('account'|'person', …)` for every
  sensitive field (SSN, ID number, tax ID never travel as plain values) plus
  plain non-sensitive fields, and stamps `tos_acceptance` from the
  server-derived date/IP/user agent on every submit.
  `GET`/`POST /api/stripe/connect/identity` (vendor twin under
  `/api/vendor/stripe-connect/identity`); document upload proxies to Stripe
  Files through `…/identity/document` and returns only a file id.
  `isApplicationCollected()` in `src/lib/stripe-connect.ts` distinguishes a
  new (`stripe_dashboard.type: "none"`) account, which uses this form, from a
  legacy `"express"` account, which keeps the embedded component — the
  `onboard` routes 409 `USE_IN_APP_IDENTITY` for the former instead of
  returning `mode: "embedded"`. `payout_identity_status` (migration
  `20260920213000_payout_identity_status.sql`) is a display-only status cache
  per owner, refreshed by the `account.updated` webhook — applied to dev/test
  only so far.

# Financials Phase 3: security deposit trust sub-ledger

**Schema** — `supabase/migrations/20260712110000_security_deposit_trust.sql`: `security_deposit_ledger` (per-deposit sub-ledger with disposition status/itemization), `manager_bank_accounts` / `manager_bank_statements` / `manager_bank_statement_lines` (reconciliation foundation), `manager_reclassification_log` (audit).

**Lib** — `src/lib/reports/security-deposits.ts`: `receiveSecurityDeposit()` (hooked from `syncLedgerPaymentEntry` on paid `security_deposit` charges), `disposeSecurityDeposit()` (move-out refund/withhold + GL), `reclassifyMisclassifiedDeposits()` (dry-run + opt-in historical fix from `other_income` → liability).

**GL** — `postGlDepositDisposition` / `postGlReclassifyDeposit` in `gl-posting.ts` (`deposit_refund` / `adjustment` source types).

**API** — `POST /api/reports/security-deposits/reclassify` (`dryRun` default true), `GET /api/security-deposits`, `POST /api/security-deposits/[id]/dispose`.

**Reports** — `queryTrustAccountBalance` (three-way bank = GL trust cash = GL liability = sub-ledger), `queryFinancialDiagnostics` (unbalanced journals, trust mismatch, misclassified deposits, expired insurance). Finances tabs **Trust account** + **Diagnostics**. Income statement excludes non-income ledger categories (deposits no longer inflate rental income).

**PostHog:** `security_deposit_disposed`, `security_deposit_reclassification_run` (server).

**Deploy:** `npm run db:push` for `security_deposit_ledger` + bank tables before sub-ledger writes succeed.

**Returning a deposit from the ledger panel** is a second, narrower path beside
`dispose`: `POST /api/portal/deposit-return` refunds the resident's original
Stripe charge in full or in part. `src/lib/deposit-return.ts` holds the whole
decision and touches neither Stripe nor the database — it refuses anything that
is not a paid, settled `security_deposit` with a Stripe charge id and remaining
balance, so a cash/check deposit or an unsettled ACH debit is turned away rather
than guessed at. The route re-reads ownership, the amount already returned, and
the charge id server-side; the client supplies only the charge id and an optional
amount.

**That route deliberately writes NO ledger entry**, which is the one documented
exception to "post next to the DB write": Stripe's `charge.refunded` webhook
already reverses the deposit liability, and it fires whether the refund came from
this button or from the Stripe dashboard, so it is the only place that can be
correct for both. Writing here too would double-count every return. Coverage:
`tests/unit/deposit-return.test.ts`, `tests/unit/deposit-return-route.test.ts`.

# PropLane balance ledger (night/vendor-pay, `PROPLANE_BALANCE_ENABLED`, default off)

**Schema** — `supabase/migrations/20260925073005_proplane_balance_ledger.sql`:
`proplane_balance_accounts` (`owner_kind: "workspace"|"vendor"`, `owner_key`
— the MANAGER's `profiles.id` for `"workspace"`, not `portal_workspaces.id`;
every existing money path here is keyed on the manager user, and a workspace
has no Connect account of its own) and `proplane_balance_entries` (signed
`amount_cents`, `kind`, `status: "pending"|"available"`, `available_on`,
`stripe_object_id` — the real Stripe object this entry mirrors, null only for
an internal `vendor_payment_out`/`vendor_payment_in` leg that moves no real
money). Both tables are locked to `service_role` (RLS enabled, no
anon/authenticated policy at all) — every read and write goes through
`src/lib/proplane-balance/ledger.server.ts`, never client-side. `vendor_invoices`
gained `paid_from: "stripe"|"balance"`.

**The ledger is a strict mirror of Stripe, never a source of new money.**
`proplane_balance_move` (the double-entry mover behind "Pay vendor from
balance") locks both account rows in a fixed id order, raises
`INSUFFICIENT_BALANCE: available=<n> requested=<n>` rather than moving
anything short, and is idempotent per `idempotency_root`. Withdrawal is
claim-before-call (`proplane_balance_withdrawal_claim_unique`, same pattern as
`stripe_payouts_pending_claim_unique`): `withdraw.server.ts` claims the debit,
THEN calls real `transfers.create` (platform → the owner's own Connect
account) and `payouts.create` on it — a failed transfer reverses the ledger
claim; a failed payout does NOT, because the money already left the platform
balance for the recipient's own Connect account by then (real, retryable money
there, not PropLane's to reverse).

**Funding**: resident household-charge checkout is the one caller that can
request `fundingModel: "platform_ledger"` on `createAxisAchCheckoutSession`
(see resident-payments.md) — application fees, autopay, and vendor-invoice-pay
checkout never do, so they are unaffected by this flag.

**Compliance note (see `.lavish/night/research.md` § Recommended money
architecture):** as long as this ledger stays a strict mirror of real Stripe
Connect objects, PropLane stays out of unlicensed-money-transmitter territory
(Stripe remains the licensed money transmitter for every dollar). Separate
charges and transfers puts negative-balance/refund/dispute liability on
PropLane, not Stripe or the connected account — a direct cost of holding funds
this way. Once pricing is platform-controlled (Custom accounts, this
architecture), PropLane — not Stripe — is responsible for 1099-K/1099-NEC
filing; nothing here files one yet.

**Balance-dependent UI dark-launches behind a SECOND flag, `WORKSPACE_CONNECT_ENABLED`
(`src/lib/workspace-connect/flag.ts`)** — the per-workspace Connect architecture
(C186-C189), independent of `PROPLANE_BALANCE_ENABLED` above. `GET
/api/portal/proplane-balance` returns both `enabled` (this ledger) and
`workspaceConnectEnabled` (that flag) so a new balance-spending surface can
require both without either flag knowing about the other:

- **Outgoing "Pay from balance" (C098)** — `ManagerOutgoingPaymentDetail`
  offers `"balance"` as a payment method (`manager-vendor-payment-flow.ts`)
  once both flags read on, defaulting to it, and submits the SAME
  `POST /api/portal/work-orders/approve-pay` every other channel uses with
  `paymentChannel: "balance"` — that route and its `insufficient_balance` 422
  already existed (`work-order-approve-pay.server.ts`); only the UI wiring and
  the ACH-fallback handling (switch to `"ach"` on 422, never a dead end) are
  new here.
- **Finances overview "Money-in" actions (C255)** — a gated row of "Pay
  vendors" / "Plan & credit" and "Withdraw"
  (`ProplaneBalanceCard variant="subordinate"`, deliberately lighter chrome so
  it never reads as a third same-weight action) on
  `finances-overview.tsx`.
- **"Pay vendors" bulk pay (C260/U043, Sep 2026)** — `PayVendorsCard`
  (`src/components/portal/finances/pay-vendors-card.tsx`) replaced the plain
  link with the real list: every `approved`/`scheduled` invoice from
  `GET /api/manager/vendor-invoices`, each with its own "Pay from balance" (or
  an honest "Balance short $X" in place of the button when it will not fit),
  plus a "Pay all approved" bulk action once more than one is outstanding.
  Both single and bulk pay call the SAME existing
  `POST /api/vendor/invoices/[id]/pay-from-balance` route, once per invoice,
  sequentially and server-authorized every time — no batch endpoint was
  added. `selectVendorInvoicesWithinBalance`
  (`src/lib/vendor-invoice-bulk-pay.ts`) is the pure running-balance greedy
  pick "Pay all approved" previews client-side (an invoice that does not fit
  is skipped, not a stop, so a smaller one later in the list can still be
  taken); it decides only what to ATTEMPT — the server re-checks the real
  balance and status on every call, so a stale preview can under- or
  over-attempt but never mis-charge. No ACH fallback: the only card-funded
  rail in the codebase (`work-order-approve-pay.server.ts`'s Stripe Checkout
  path) writes to `portal_work_order_records`/`vendor_payouts` and never
  touches `vendor_invoices`, so routing a balance shortfall through it would
  leave the invoice stuck `approved` while already paid on a different rail —
  a real desync, not a UI gap. Building a genuine ACH rail for
  `vendor_invoices` directly was out of scope ("don't invent a payment
  rail"); this is deliberately unbuilt, not overlooked.

**Vendor banking (`VENDOR_BANKING_ENABLED`, `src/lib/vendor-banking/flag.ts`)**
— the 3% vendor take rate, manual Connect payout schedule, 90-day hold-expiry
job, vendor refund route, and balance/statement/reconciliation surface — is
**default ON** (captain, 2026-09-28). Set `VENDOR_BANKING_ENABLED=0` (or
`false` / `off`) in an environment to fall back to the pre-feature behavior
(no `vendor_banking_*` row is written, fee/schedule math returns 0).

# Financials Phase 5: AP bills, budgets, owner statements

**Schema** — `supabase/migrations/20260712120000_manager_bills_ap.sql`: `manager_bills`, `manager_budgets`, `manager_property_owners`, `manager_reserve_policies`, `manager_owner_distributions`; `vendor_invoices.bill_id` FK to `manager_bills`.

**Lib** — `src/lib/manager-bills.ts` + `manager-bills.server.ts`: create/approve/pay bills (paid bills write `manager_expense_entries` + GL), `createBillFromVendorInvoice` on invoice approve.

**GL** — `postGlBillApproved` (DR expense / CR AP), `postGlBillPaid` (DR AP / CR cash) in `gl-posting.ts`.

**API** — `GET/POST /api/manager-bills`, `PATCH /api/manager-bills/[id]` (`approve`/`pay`/`void`).

**Reports** — `queryApAging`, `queryBudgetVsActual`, `queryOwnerStatement` in `ap-reports.ts`; Finances tabs **AP aging**, **Budget**, **Owner statement**.

**PostHog:** `bill_created`, `bill_approved`, `bill_paid` (server).

# Financials Phase 6: receivables completeness

**Schema** — `supabase/migrations/20260712130000_receivables_phase6.sql`: `manager_billing_settings`, `manager_payment_plans`, `manager_late_fee_waivers`.

**Charge status** — `HouseholdCharge.status` extended: `pending|partially_paid|paid|cancelled|refunded|failed` + optional `paidAmountCents`; `applyPartialPaymentCents` in `nsf-fees.ts`.

**NSF** — `payment_intent.payment_failed` webhook marks charge `failed` and `createNsfFeeForFailedPayment` when `manager_billing_settings.nsfFeeEnabled` (default $35).
**The NSF fee id is per failed payment attempt** (`nsfFeeIdForCharge`,
`hc_nsf_<chargeId>_<paymentIntentId>`, falling back to `hc_nsf_<chargeId>` with no
intent id — no `Date.now()`), and `handlePaymentIntentFailed` reads that id before
writing, so a redelivered failure webhook for the same attempt never mints a second
fee while a retry that fails on a new intent is fee'd again. Coverage:
`tests/unit/nsf-fee-idempotent.test.ts`.

**Settings** — `src/lib/manager-billing-settings.ts` (`paymentApplicationOrder`, NSF toggle/amount).

**Deploy:** `npm run db:push` for Phase 5+6 tables before bill/NSF paths succeed.

# Payment record page: only a tab that can have data

The manager payment record page (`pro-payments-ledger-panel.tsx`) filters
`recordSections("manager", "payment", …).groups` per row rather than showing
every registered tab unconditionally: **Service** only for a
`chargeKind === "work_order_charge"` row (a paid add-on/work-order charge),
**Vendor** never (a resident charge is never a vendor payment — that money
moves on the Outgoing side, a different record), **Documents** never (no
upload path exists for a charge), **Activity** only when `migrationSourceId`
is set (an imported charge has a real migration event; an ordinary one does
not). Coverage: `tests/unit/payment-record-linked-sections.test.tsx`.

# Manager charge counts: one bucket rule, one scoping rule

Two manager surfaces show the same money — the dashboard "Payments" attention
group and `/portal/payments`, which that group's "View all N →" links to — and
they used to compute it two different ways, so the dashboard advertised counts
the destination page did not have. Both rules now live in one place each; the
modules' header comments carry the full rationale.

- **`householdChargeManagerBucket` (`src/lib/household-charges.ts`) is the ONE
  Pending / Overdue / Paid decision** for a manager-facing charge, and every
  manager surface that counts charges must go through it. All seven statuses land
  in one of the three: `paid` / `cancelled` / `refunded` → **paid** (settled, and
  nothing actionable — the GL is the accounting record, this is only the
  collections view); `processing` → **pending**, never overdue (the ACH debit is
  clearing); `pending` / `partially_paid` / `failed` → **pending**, or **overdue**
  once past due. Bucketing on `status === "pending"` alone is what dropped
  clearing-ACH rows from the dashboard while Payments counted them.
- **`src/lib/manager-payments-scope.ts` is the ONE Payments-ledger scoping.**
  `readChargesForManager` is narrowed by two extra rules (plus the manager's own
  Upcoming choice, below), and **each is deliberately as narrow as it can be —
  money a manager cannot see is money they never chase**:
  - **Internal payer accounts are matched EXACTLY, email first**
    (`shouldExcludePaymentAccount`) — never as a substring on name-or-email,
    which swallowed every real resident whose name or address merely contained
    the token.
  - **A charge is dropped only for a resident who has MOVED OUT** — an email
    with an approved-but-no-longer-current row AND no current-resident row
    anywhere — except a manager-entered one-off, which stays visible
    deliberately. Keying on "not a current resident" also catches pending,
    in-progress, rejected and withdrawn rows, so a resident holding a SECOND
    application had every charge vanish from both money surfaces.

  The rules live in that module rather than being copied into each caller, and
  **Payments is the authority**: align a new counter to it, not the reverse.
- **A not-yet-due charge is "Upcoming", and the manager can hide it.**
  `isUpcomingHouseholdCharge` (`src/lib/household-charge-visibility.ts`) is the ONE
  decision: an outstanding charge whose `rentMonth` — else the month of its due
  date — is a later calendar month than now. The Pending bucket renders those in a
  trailing **Upcoming** group (`pro-payments-ledger-panel.tsx`), and the manager
  `list_charges` tool reports the same flag as `upcoming`. The manager automation
  setting `showUpcomingCharges` (default Show) is ONE saved value with two entry
  points — Payment settings → Payment setup and the list's Filter sheet, both
  `PATCH /api/portal/automation-settings` — and Hide drops those charges from the
  list AND from the Pending count. `readManagerPaymentsLedgerCharges` is
  synchronous, so it reads the setting from a `sessionStorage` mirror
  (`cacheShowUpcomingChargesSetting` / `readCachedShowUpcomingChargesSetting` in
  `payment-automation-settings.ts`) that every loader and saver of the real
  settings refreshes; nothing cached means Show, so a surface that never loaded
  settings filters nothing.

Coverage: `tests/unit/manager-payments-dashboard-agreement.test.ts`,
`tests/unit/manager-payments-upcoming.test.tsx`,
`tests/unit/tools/charges-upcoming-visibility.test.ts` (the `upcoming` tool flag), and the
browser regression `npm run test:payments-upcoming`
(`tests/browser/payments-upcoming/README.md` — list, Filter sheet, settings dialog,
record header actions, resident window; real components, no dev server).

## Sales migration, utility allocations and statement intake

See [Sales migration](sales-migration.md) for version-2 canonical imports,
source provenance, billing holds, actual-bill utility allocation, inspection-backed
deposit review, and bank CSV intake. **Financial-fact ids are workbook-independent**
(`resolveFinancialFactId` in `sales-migration/server.ts`) — a re-imported workbook
with a corrected `workbookId` lands on the same income/expense/charge id it did the
first time instead of duplicating it, falling back to the legacy workbook-scoped id
only when one already exists there (an in-progress import stays on the id it
started with). Coverage: `tests/unit/sales-migration-reimport-idempotent.test.ts`.
Ordinary and imported deposit dispositions
share the atomic `commit_security_deposit_disposition` RPC; do not post a journal
and update its held balance in separate transactions. Itemization is cumulative,
with current refund journals distinguished from prior refunds in the PDF.
Bank matching supports one receipt or expense target and checks owner, signed
amount and exclusive consumption in the database for every writer.

# Profitability report (PRP-278)

`src/lib/reports/profitability.ts` (pure aggregation) + `profitability.server.ts`
(the reads), registered as report id `profitability` and rendered as the
read-only **Profitability** card at the top of Finances → Income
(`pro-profitability-card.tsx`; hidden in `/demo`). `groupBy=property` (default,
one row per property over the range) or `groupBy=month` (one row per property
per month); the range pills are the cash-flow chart's `CashflowRangeToggle`.
CSV goes through the ordinary `/api/reports/profitability/export?format=csv`.
Every column is a sum over rows a table already holds — nothing is derived from
a rate card, and a category that cannot be sourced is 0 with the reason in
`meta.source_<column>`:

| Column | Source |
| --- | --- |
| Gross rent | `ledger_entries` payment rows with `category_code = rent_income` (every rent-kind charge maps there via `categoryCodeForChargeKind`), by `posted_date`. |
| Other income | `ledger_entries` payment rows in every other **income** account (late fees, utilities, application/move-in fees, manual income). Liability accounts (security deposits) are excluded, as in `queryIncomeStatement`. |
| Processing fees | Fees the MANAGER bore, per payment row: `stripe_fee_cents` (0 on today's Connect destination charges) plus the retained application fee, `amount_cents − net_cents` when positive. When the resident paid the service fee, `net_cents` equals the charge and the row contributes 0; a row Stripe has not enriched (`net_cents` null) contributes 0. Never the resident's fee. |
| Vendor payouts | `vendor_payouts` rows with `status = 'paid'`, dated by `updated_at` (when the transfer settled); property via the work order's `property_id` / `assigned_property_id`. |
| Communication | `manager_comms_usage_events.total_cents` per UTC calendar month above the plan's included allowance (`allowances.ts`, via `getEffectiveManagerSkuTier`); 0 while within it. Portfolio-wide, so it sits on the "Portfolio (unassigned)" row and is 0 when a property filter is active; 0 with a note when the plan cannot be read. |
| Expenses | `manager_expense_entries` by `expense_date` (includes expenses created from services and paid bills). |
| Net | gross rent + other income − processing fees − vendor payouts − communication − expenses. |

PostHog: `profitability_report_viewed` `{ months, propertyCount }` fires on the
server next to the successful read. Coverage:
`tests/unit/reports/profitability.test.ts`.

## Studio redesign 0929: collections, outgoing and activity

Manager navigation separates **Incoming payments** (`/portal/payments`) from
**Outgoing payments** (`/portal/outgoing/{to-pay|scheduled|paid}`). The latter
uses the manager invoice endpoint with `outgoing=1`: paginated, active-workspace
scoped invoices and payout history, server-calculated integer-cent totals, and
unpaid eligibility requiring an approved/scheduled invoice linked to a service
assigned to its vendor. Historical paid rows remain readable. New payment
execution stays unavailable until checkout concurrency and AP settlement are
safe; a display status must never stand in for money movement.

Finances has Overview, Activity and Reports. `financial-activity` reads recorded
payment/refund ledger rows and expense entries, with chart-of-accounts types
controlling operating totals and the deposit subledger controlling held funds.
It does **not** yet reconcile every Stripe/platform movement or supply a running
PropLane balance; never invent an opening balance to hide those missing sources.

The offline receipt sheet posts `recordOfflinePayment` to
`/api/portal-household-charges`, passing only charge id, date, method and note.
The server re-reads the amount, checks ownership/workspace and current status,
compares status and `updated_at` before writing, and awaits payment ledger sync.
An identical persisted receipt can retry ledger repair after a failure.

# Payees (who a payment goes to)

**"Add payment" is the one door for money going out** (`pro-add-outgoing-payment-modal.tsx`; Outgoing page and Payments page both open it). Steps: Pay to · Payment · Review.

- **A vendor with a PropLane login** pays through the invoice flow (`/api/manager/vendor-invoices`, untouched): an approved invoice hands off to the host's "Pay $x from <source>" step (or `outgoing/to-pay?payInvoice=<id>`), "New bill" files a bill. One step; no payee row.
- **A teammate** is an expense with the teammate as payee (reimbursement, management fee). PropLane moves no money to teammates.
- **Someone else** (mortgage lender, utility, insurer, tax office, HOA, owner) is a saved payee. A new payee is saved when the manager continues past Pay to.

**Schema** — `supabase/migrations/20261004010000_manager_payees.sql`: `manager_payees` (one owner column, `manager_user_id`, like `manager_expense_entries`) and `manager_expense_entries.payee_id` (`on delete set null`, so deleting a payee never deletes the books). Pure vocabulary, validation, the type -> category map and masking live in `src/lib/manager-payees.ts`.

**Invariants**

- **Never store a bank account or routing number.** `account_reference` is the lender / utility account or loan number as printed on the bill; lists and Review show only `••` + last four.
- **Client roles can SELECT their own rows only.** Every write goes through `/api/manager/payees` (service-role client pinned to the session manager inside `manager-payees.server.ts`); the table is also in the test-workspace restrictive deny. A payee id from a request is a claim, never ownership: `/api/expenses` POST calls `findOwnedPayee` and answers 404 for a foreign, archived or missing id.
- **An expense may only name its own manager's payee, and the database holds that**, not just the route: `manager_expense_entries_owner` is `for all` on `manager_user_id` alone, so RLS lets a signed-in manager PATCH `payee_id` straight through PostgREST, around `findOwnedPayee`. The `manager_expense_payee_same_owner` trigger (`supabase/migrations/20261004020000_expense_payee_same_owner_and_one_accepted_bid.sql`) rejects a cross-tenant `payee_id` for every writer.
- **A teammate payee must be on the manager's team**, re-derived from accepted `account_link_invites` in either direction on every create; the payee's name comes from the team, never the request.
- The category follows the payee type until the manager changes it (`payeeCategoryCode`: mortgage -> mortgage, utility -> utilities, insurance -> insurance, tax -> property_tax, teammate -> management; HOA, owner and other -> other_expense since the chart has no HOA account).
- An expense has no status: a payee payment is recorded as already made and lists under **Paid** (`buildPayeePaymentRows` on the Outgoing page; `payeeTypeLabel` / `payeeReferenceLabel` on the Payments page rows). A "To pay" payee bill needs a bills/AP status first (see `manager_bills`).
- New table is classified in `account-purge-manifest.ts` (`manager_payees`: deleted with the manager, `teammate_user_id` detached).

Coverage: `tests/unit/manager-payees.test.ts`, `manager-payees-route.test.ts`, `add-payment-modal.test.tsx`.
