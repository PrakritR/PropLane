# One-shot waiver: 2026-09-11 production communication billing

Status: **DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED**

This draft names a prospective production schema operation for later explicit
approval under `.cursor/rules/no-production-data-writes.mdc`. Akhil approved
preparing this candidate only. Nothing in this document authorizes a database
write, deployment, provider action, or protected-branch mutation.

## Proposed bounded candidate

Preparation entrypoint:
`scripts/prepare-20260911-comms-billing-migrations.mjs`

- Entrypoint SHA-256: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`
- Candidate identity: `20260911161000_comms_billing_rollout`
- Atomic bundle: 67,040 bytes
- Atomic bundle SHA-256: `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`
- Pinned Git source: `8ce3868b4e5775661956c6c3f36fcb146bfa931a`

The prospective operation is limited to these six exact sources in order:

1. `20260910140000_manager_communication_credits.sql` - 21,013 bytes - `70e8ddd6138d74f67712076498ec6d5d88f2568470fe446b9954aa4102562c13`
2. `20260910160000_comms_credit_alerts.sql` - 1,725 bytes - `d6b0dc09f80894e26e1b8b0b9df25f98e85729b948c2c9f94130211481bea07f`
3. `20260910170000_manager_billing_customer.sql` - 354 bytes - `7ff6fc4cbaf2e2835194610ea8af22aaa9b772bb1e5ba76943fceaf1336fd4da`
4. `20260910180000_comms_wallet_snapshots.sql` - 1,153 bytes - `c67d8283ba00d4c1798b370eb5d1374c9309c3f78ed9e9d6086bf87f7bf1572b`
5. `20260910190000_sms_outbox_campaign_budget.sql` - 1,467 bytes - `9c32e16882f869ae059483655b087117edd2a2c740a40321dc9c28f2d53ead47`
6. `20260911160000_comms_credit_recovery_guards.sql` - 1,579 bytes - `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`

Source six is a proposed additive correction. It attaches the existing account
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
single statement. A future reviewed PostgreSQL apply runner may record one
auxiliary `20260911161000_comms_billing_rollout` row containing the complete
bundle as one statement in the same transaction. The auxiliary representation
must not change the bundle hash above.

## Explicit exclusions and later gates

- The preparation entrypoint accepts no arguments and has no apply, remote,
  database URL, target override, or generic SQL path.
- A fixed, certificate-verified apply entrypoint does not exist for this scope.
  It must be implemented, independently reviewed, and fingerprinted before any
  approval request or execution.
- No reuse of the consumed `2026-09-11-production-recovery-schema` waiver.
- No production, staging, or dev database write; no seed, wipe, ledger repair,
  SQL Editor action, provider call, payment, message, account lifecycle action,
  deployment, merge, push, or TestFlight operation.
- No write to a protected listing, including 5257 / 5259 Brooklyn and 4709A
  8th Avenue.
- No application release or enablement of `COMMS_PAYG_BILLING_ENABLED`.
- The legacy communication invoicer must be proved unable to bill prepaid usage
  in current and rollback deployments before prepaid traffic is enabled.
- The correction must first be adopted into `supabase/migrations` with identical
  bytes after main is integrated. Staging schema and full application QA remain
  mandatory before a production operation.

Fresh production and staging metadata showed all five pinned targets absent,
the relevant new tables absent, a compatible `manual_payments` column, and zero
qualifying backfill rows. Current Vercel runtime/build environment inventories
also omitted `COMMS_PAYG_BILLING_ENABLED`. These are preparation facts only,
not approval or proof of rollback-deployment behavior. Every condition must be
rechecked immediately before any future apply.

## Approval record

No production approval has been requested or recorded. After main integration,
canonical correction adoption, staging QA, cutover proof, apply-runner review,
and fresh target preflight, Akhil must explicitly approve this exact named
waiver and the then-recorded fixed apply-entrypoint hash. A successful operation
would consume it once; an uncertain outcome must not be retried.
