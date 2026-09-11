# Communication billing rollout preparation

Astra plan, September 11 2026. User approved preparing a separately bounded
rollout, not applying it. Keeper akhil/backlog-repeat-issues at
dbb3836e36ec23abd347f16d3eb1b7df7270b015, worktree
/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2.

## Scope and architecture

Prepare and locally validate a six-source candidate: the exact five existing
communication-billing migrations from pinned Git source
8ce3868b4e5775661956c6c3f36fcb146bfa931a, plus one proposed additive correction
attaching the existing account-recovery guards to the two new account-owned
credit history tables. Root has explicitly told Akhil about this added safety
scope. Production approval will name all six, never silently reuse the earlier
twelve-source waiver. No remote migration, application/provider operation or
protected-branch mutation is authorized in this phase.

Do not merge main to this keeper yet: its dispatcher conflict and application
QA are separate work. Do not copy five historical migrations or main app files
into this older keeper merely to make tests load. Read their exact pinned Git
objects, fail on missing objects or digest mismatch. Keep the correction as a
proposed SQL artifact under scripts/rollouts/2026-09-11-comms-billing/, not a
canonical migration whose prerequisites are absent from this keeper. Adoption
into supabase/migrations with identical bytes must follow main integration.

Named preparation entrypoint:
scripts/prepare-20260911-comms-billing-migrations.mjs.
Proposed correction file:
scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql.
Named DRAFT waiver: docs/waivers/2026-09-11-production-comms-billing.md.
Candidate bundle identity: 20260911161000_comms_billing_rollout.

The preparation CLI has NO --apply, remote client, database URL, target override,
or generic SQL input. Default prints sanitized manifest/report/fingerprints.
Export a deterministic bundle builder for the disposable local harness. The
eventual apply mechanism should reuse verified pg design from the completed
recovery operation, but do NOT implement a remote apply path or alter that
consumed runner/certificate in this phase.

## Pinned existing sources

All under supabase/migrations in the pinned Git source; bytes and SHA-256:

- 20260910140000_manager_communication_credits.sql, 21013,
  70e8ddd6138d74f67712076498ec6d5d88f2568470fe446b9954aa4102562c13
- 20260910160000_comms_credit_alerts.sql, 1725,
  d6b0dc09f80894e26e1b8b0b9df25f98e85729b948c2c9f94130211481bea07f
- 20260910170000_manager_billing_customer.sql, 354,
  7ff6fc4cbaf2e2835194610ea8af22aaa9b772bb1e5ba76943fceaf1336fd4da
- 20260910180000_comms_wallet_snapshots.sql, 1153,
  c67d8283ba00d4c1798b370eb5d1374c9309c3f78ed9e9d6086bf87f7bf1572b
- 20260910190000_sms_outbox_campaign_budget.sql, 1467,
  9c32e16882f869ae059483655b087117edd2a2c740a40321dc9c28f2d53ead47

Read all five, docs/agents/comms-billing.md from that Git source, local
docs/agents/account-recovery-design-draft.md, local database environment and
production locks, and root evidence. Ordinary financial/AI application rules
remain intact. This is not an app UI task; no browser/provider write is proof
needed for the preparation artifact itself. Full feature QA remains a release gate.

## Correction and atomic candidate

First reproduce missing recovery guards against local PostgreSQL after actual
recovery migrations followed by the five sources. Then proposed correction adds
account_recovery_write_guard BEFORE INSERT/UPDATE/DELETE FOR EACH ROW and
account_recovery_capture_delete AFTER DELETE FOR EACH ROW on ONLY
manager_comms_credit_purchases and manager_comms_credit_adjustments. Reuse exact
existing trigger functions, no duplicated lifecycle logic, global event trigger,
RLS change, financial policy change, or guard bypass. Idempotent trigger DDL;
missing prerequisite tables/functions must fail closed. Global comms_credit_policy
needs no account guard. Prove write blocking AND capture behavior, not just names.

Bundle retains all six source bytes exactly, in timestamp order. Wrap in one
explicit transaction with 3s lock timeout, 60s statement timeout, a dedicated
transaction advisory lock, exact target migration/auxiliary absence and object
preconditions. Already present compatible manual_payments is allowed. Any new
credit tables/columns/functions/index or target ledger identity partial/conflict
must reject rather than rely on IF NOT EXISTS. Require zero qualifying existing
payment-preference backfill rows before sources, under a relation lock preventing
drift. Recheck this in the eventual real preflight. Test backfill SQL semantics
separately on synthetic rows, without relaxing the production candidate's zero-row
gate. Preserve existing columns/constraints/rows and recovery guards except the
explicit credit additions/source quantity constraint changes. No guard disablement.

Record exactly six original source ledger rows with statements=[exactSource].
The future pg apply can insert one auxiliary [completeBundle] row, matching the
already-reviewed representation. Avoid self-referential bundle hashes. The local
harness can exercise that insertion separately in the same transaction, before
COMMIT and fresh readback. Preparation report records exact source/bundle hashes.
Postchecks must verify new RLS/grants, exact RPC identities/privileges, credit
defaults/constraints/customer unique index, four trigger definitions, singleton
policy row, ledger bytes and unchanged historical ledger. No blanket RLS weakening.

## Delegate ownership and tests

Fresh Sol-medium manager integrates and verifies; Terra owns preparation script,
proposed SQL correction and a disposable local PostgreSQL rehearsal; Luna owns
focused unit tests and independent manifest/risk checklist review. Assign these
disjoint files once. Do not repeat the previous late ownership-switch race.
No delegate contacts production/staging/providers, reads credentials, commits,
pushes, merges, or edits consumed recovery artifacts. No no-mistakes.

Use existing local recovery fixture and actual buildAtomicBundle to seed only
the disposable localhost PostgreSQL baseline; add needed minimal profiles.created_at,
billing/automation/SMS tables and canonical spend function BEFORE installing
recovery so chronology matches live. Reuse pinned source existing wallet/campaign
test scenarios where practical without importing unrelated app dependencies.

Required local acceptance: clean full candidate; original five demonstrate missing
guards and correction closes it; archive-held insert/update/delete protection and
legitimate capture/recovery behavior; repeated correction idempotence; transaction
rollback after source1/source5/correction; dirty/partial/ledger-conflict rejection;
zero-backfill gate with concurrent settings writer; synthetic backfill empty vs
nonempty/non-object/null; old-live style usage/settings writes remain valid after
schema; concurrent reservation/campaign cap/idempotency; read-only wallet snapshot
and existing-manager grandfathered allowance; service-role-only table/RPC grants;
customer partial unique index and UTC alert definition. No remote payments/messages.
Use the narrowest tests; avoid another unnecessary whole-app build/full suite for
preparation-only files. Report actual command exit codes. Run scoped lint/syntax,
unit tests maxWorkers1, local rehearsal, diff/hash checks, source/consumed-file
unchanged checks. Attempt required graph refresh; absent/incompatible graph is
documented, never silently generated with another toolchain.

## Deliverables and stop condition

Write docs/plans/2026-09-11-comms-billing-rollout-handoff.md with fixed hashes,
exact commands/results, local pre-fix reproduction, correction proof, exclusions
and remaining rollout gates. Fill DRAFT waiver with all six sources and exact
bundle/entrypoint hashes, data effects and zero-backfill condition. DO NOT mark
production approved. Root then launches fresh independent Astra review (target
under five minutes using the focused evidence), corrects at most two cycles,
and commits/pushes only reviewed keeper scope. Handoff asks Akhil to approve
the NEW named waiver only after the complete candidate exists. Application merge,
canonical correction adoption, actual staging QA and legacy-invoicer cutover
must be planned before any real production operation. Any source risk requiring
more than this proposed correction is a planning blocker, not permission to
silently edit the five pinned migrations.
