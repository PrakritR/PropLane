# One-shot waiver: 2026-09-11 production communication billing

Status: **CONSUMED**

This named one-shot waiver records Akhil's September 11, 2026 instruction to
apply the bounded billing migrations under `.cursor/rules/no-production-data-writes.mdc`.
It authorizes only the exact six-source schema transaction below, once, on
production project `qahnczmilgptcedaqype`. It does not authorize payment, message,
listing, account, provider, or other customer-data operations.

## Approved bounded candidate

Preparation entrypoint:
`scripts/prepare-20260911-comms-billing-migrations.mjs`

- Entrypoint SHA-256: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`
- Candidate identity: `20260911161000_comms_billing_rollout`
- Atomic bundle: 67,040 bytes
- Atomic bundle SHA-256: `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`
- Pinned Git source: `8ce3868b4e5775661956c6c3f36fcb146bfa931a`

The approved operation is limited to these six exact sources in order:

1. `20260910140000_manager_communication_credits.sql` - 21,013 bytes - `70e8ddd6138d74f67712076498ec6d5d88f2568470fe446b9954aa4102562c13`
2. `20260910160000_comms_credit_alerts.sql` - 1,725 bytes - `d6b0dc09f80894e26e1b8b0b9df25f98e85729b948c2c9f94130211481bea07f`
3. `20260910170000_manager_billing_customer.sql` - 354 bytes - `7ff6fc4cbaf2e2835194610ea8af22aaa9b772bb1e5ba76943fceaf1336fd4da`
4. `20260910180000_comms_wallet_snapshots.sql` - 1,153 bytes - `c67d8283ba00d4c1798b370eb5d1374c9309c3f78ed9e9d6086bf87f7bf1572b`
5. `20260910190000_sms_outbox_campaign_budget.sql` - 1,467 bytes - `9c32e16882f869ae059483655b087117edd2a2c740a40321dc9c28f2d53ead47`
6. `20260911160000_comms_credit_recovery_guards.sql` - 1,579 bytes - `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`

## Reviewed fixed apply runner

Fixed runner: `scripts/apply-20260911-comms-billing-migrations.mjs`

- Runner SHA-256: `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`
- Fixed staging target: `xwszcafaontidfgznlxd`
- Fixed production target: `qahnczmilgptcedaqype`
- Production acknowledgement name: `2026-09-11-production-comms-billing`

Fresh independent Astra review on September 11 found no blocking runner defect
and independently matched the exact runner, preparation, bundle, and canonical
correction fingerprints. Those identities remain immutable for this operation.

Source six is an additive correction adopted into canonical migrations. It attaches the existing account
recovery write guard and delete-capture trigger functions to only
`manager_comms_credit_purchases` and `manager_comms_credit_adjustments`. It does
not duplicate or bypass recovery lifecycle logic.

## Expected data and schema effects

The five pinned sources create the prepaid communication policy, purchase and
adjustment histories, wallet and reservation RPCs, budget-alert claim, billing
customer identity, read-only bulk snapshots, and campaign budget idempotency.
They add the reviewed credit columns and constraints to existing billing,
usage, automation, and SMS tables. The correction adds four recovery triggers.

The candidate requires zero rows eligible for the legacy payment-preference
backfill at execution time: `manual_payments = '{}'::jsonb` and
`jsonb_typeof(row_data->'manualPayments') = 'object'`. The settings relation is
locked before this check. An already-present `manual_payments` column is allowed
only when it is `jsonb NOT NULL DEFAULT '{}'::jsonb`. Any target object,
incompatible column, partial/conflicting ledger identity, or nonzero qualifying
backfill rejects the whole transaction.

The candidate records six original ledger rows with each exact source as its
single statement. The reviewed PostgreSQL apply runner records one
auxiliary `20260911161000_comms_billing_rollout` row containing the complete
bundle as one statement in the same transaction. The auxiliary representation
must not change the bundle hash above.

## Explicit exclusions and later gates

- The preparation entrypoint accepts no arguments and has no apply, remote,
  database URL, target override, or generic SQL path.
- Only the fixed, certificate-verified apply entrypoint above may execute this
  operation. No generic SQL, connection override, or alternative runner.
- No reuse of the consumed `2026-09-11-production-recovery-schema` waiver.
- No database write beyond the exact atomic schema bundle and its seven truthful
  ledger rows; no seed, wipe, ledger repair, SQL Editor action, provider call,
  payment, message, or account lifecycle action. This waiver itself grants no
  deployment, merge, push, or TestFlight authority.
- No write to a protected listing, including 5257 / 5259 Brooklyn and 4709A
  8th Avenue.
- No application release or enablement of `COMMS_PAYG_BILLING_ENABLED`.
- The legacy communication invoicer must be proved unable to bill prepaid usage
  in current and rollback deployments before prepaid traffic is enabled.
- The correction must first be adopted into `supabase/migrations` with identical
  bytes after main is integrated. Staging schema and application QA remain the
  default; the only omission allowed is the active dated exception in
  `docs/agents/temporary-direct-production-policy.json`.

Fresh production and staging metadata showed all five pinned targets absent,
the relevant new tables absent, a compatible `manual_payments` column, and zero
qualifying backfill rows. Current Vercel runtime/build environment inventories
also omitted `COMMS_PAYG_BILLING_ENABLED`. These are preparation facts only,
not approval or proof of rollback-deployment behavior. Every condition must be
rechecked immediately before any future apply.

## Approval record

Akhil's current explicit instruction, September 11, 2026:

> do the billing migrations and also remove the staging qa necessity for prod, we are ommiting staging for the next few days

This instruction follows his existing production ship approval and applies to
this prepared billing package. It is recorded here as the required named,
bounded waiver, not as a general production-write override. The staging
exception expires `2026-09-15T04:00:00Z`; all other guards remain. Execute this
one-shot waiver no later than that time. Do not request the same authority again.

Root evidence before apply:

- Integrated `origin/main` at `49096412195215f8c2b72f7ce406d78ef1aeca48`
  into the prospect keeper; canonical sixth migration has the exact approved bytes.
- Fresh independent reviewer `/root/billing_apply_review` found no blocking
  code defect and matched the runner and bundle fingerprints above.
- Fresh four-file migration unit matrix, including the mandatory disposable
  PostgreSQL harness: exit 0, 33 tests, 16.25 seconds on the integrated keeper.
- Exact runner `--preflight-production`: exit 0, six sources, 176 historical
  ledger rows, zero active sessions, long transactions and lock waiters.
  This verifies prerequisites, clean target absence, compatible manual_payments
  and zero eligible backfill; the transaction rechecks under a relation lock.
- Vercel project and current READY production deployment
  `dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T` at
  `2d1353af42c3a652be6cf8a69640468b453f4cea` omit
  `COMMS_PAYG_BILLING_ENABLED` from runtime and build environment inventories.
  The deployed helper returns before database/provider work unless that flag is
  exactly `1`. Candidate helper is unconditionally retired. Restrict rollback
  to this exact verified disabled deployment; no arbitrary older rollback.
- No environment setting, invoice cron, payment provider or customer message
  was invoked for these checks. Credit checkout remains disabled.

Run the exact runner with the approved bundle SHA and acknowledgement name
`2026-09-11-production-comms-billing`. After confirmed success and independent
readback, immediately mark this waiver CONSUMED and record the result. Any
uncertain outcome blocks retries regardless of subsequent readback. If a fresh
preflight rejects drift or nonzero backfill, stop rather than broadening scope.


## Consumption record

2026-09-11T20:07:28.079450+00:00 - Fixed runner exited 0 with
`{"outcome":"success","target":"production","migrationCount":6}`.
The runner confirmed COMMIT and independently verified the installed catalog
and exact historical plus seven new ledger rows through a fresh connection.
This one-shot waiver is consumed and must never be reused. No provider action,
customer message, payment, listing mutation or payment-preference backfill ran.

The initial invocation refused the local status spelling before acquiring
credentials or opening a database connection. Correcting it to APPROVED allowed
the single actual transaction above; no uncertain transaction was retried.
