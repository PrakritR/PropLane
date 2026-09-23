> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

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
is now the one payout UI — balance with a Withdraw action (Standard or
Instant, `payout-withdraw-sheet.tsx`), Set up steps until ready, bank
accounts, the payout schedule, and history. `/portal/payments/payouts` and
the vendor `financials/payouts` tab (`portal-payouts-panel.tsx`) still exist
and share the same Withdraw sheet and API routes; every other entry point
(the Payments setup card, the payment-settings modal's Payouts row) now
opens Profile → Payouts instead. Stripe's Express Dashboard and Account
Links are gone; identity and bank linking are Stripe's embedded
`account_onboarding` / `account_management` components mounted inside
PropLane's own modal today (a Verify/Add-bank props seam exists for the
in-house forms PLAN-0920-1500 still has to build — see
[`stripe-connect-ach-setup.md`](../stripe-connect-ach-setup.md)).
**Payments → Payouts** (`/portal/payments/payouts`, vendor twin
`/vendor/financials/payouts`) is the one payout UI — balance, a single "Pay
out" action (Standard or Instant), the bank card, the payout schedule, and
history. Stripe's Express Dashboard and Account Links are gone. Identity
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
  `src/lib/stripe-platform-hold.ts` / `.server.ts`. Ready Connect
  (`transfers` active AND `payouts_enabled`) is a destination charge —
  money goes straight to that person. No bank yet: charge the platform,
  credit a hold, transfer the leftover the moment they become ready.
  Withdraw never spends a hold. Snapshot: `availableCents` = hold +
  Stripe; `withdrawableCents` = Stripe only.
- **Stripe/DB reads and writes** — `src/lib/stripe-payouts.server.ts`:
  `readPayoutSnapshot` (balance, bank/eligibility from the external account's
  `available_payout_methods`, setup state from `account.requirements`,
  schedule, last-50 history, held vs withdrawable); `createInAppPayout` claims a pending
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
