# One-shot waiver: 2026-09-11 production recovery schema

Status: **CONSUMED - VERIFIED SUCCESS SEPTEMBER 11 2026, 06:53:10 UTC**

This document records the named, one-shot scope required by
`.cursor/rules/no-production-data-writes.mdc`. In response to the explicit
question naming this waiver and its recorded script and bundle hashes, Akhil
confirmed: "yes i approve it, lets get it done and test it and then promote it
once its done". This approves the bounded scope below and preparation of the
apply-capable change. It does not waive fresh independent review, unchanged
bundle bytes, fresh target checks, or the separate application release gates.

## Proposed one-shot scope

Named script:

`scripts/prepare-20260911-production-migrations.mjs`

Target: production Supabase project `qahnczmilgptcedaqype` only.

Approved correction-cycle-1 preparation baseline:

- Preparation script SHA-256: `ae442ea1193137a2f2d44dcde67c479675bacfe63cd494dcfb95defac3a17263`.
- Bundle: `20260911010000_production_recovery_schema.sql`, 215925 bytes.
- Bundle SHA-256: `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
- The superseded initial bundle is not covered by this candidate.

The prospective operation may install exactly one atomic CLI migration bundle
composed byte-for-byte, in stable timestamp order, from these 12 repository
migrations:

1. `20260907130000_webhook_subscriptions.sql`
2. `20260907214100_preserve_resident_financial_history.sql`
3. `20260907221500_preserve_shared_vendor_financial_history.sql`
4. `20260907223000_account_attachment_references.sql`
5. `20260907224000_account_recovery_shared_retention.sql`
6. `20260907224500_account_recovery_snapshot.sql`
7. `20260907225000_account_recovery_identity_patches.sql`
8. `20260907225500_account_recovery_capture.sql`
9. `20260907230000_account_recovery_object_generations.sql`
10. `20260907231000_account_recovery_financial_access_keys.sql`
11. `20260907232000_account_recovery_restore.sql`
12. `20260907233000_account_recovery_finish_archival.sql`

Every source digest, prerequisite, target binding, original version/name ledger
state, and object absence check must match the independently reviewed manifest.
The bundle must recheck absence inside its own transaction before executing any
source SQL. It must set a 3-second lock timeout and 60-second statement timeout,
use pinned Supabase CLI 2.117.0 with `--skip-vault`, and include no roles or seed.
It must refuse any pre-existing recovery bucket, then verify and row-lock the
private bucket after source execution and before recording migration success.

## Explicit exclusions

- The baseline preparation script rejects `--apply`. Enabling its bounded apply
  path requires fresh independent review and recording the final implementation
  fingerprint before execution. The approved bundle digest must not change.
- No generic `db push --include-all`, migration-history repair, SQL Editor run,
  broad historical replay, guessed bundle equivalence, or ledger deletion/update.
- No account deletion, recovery, snapshot, archive, restore, purge, compaction,
  attachment copy/delete, webhook delivery, cron, Twilio, Resend, or other
  application/provider action.
- No existing listing row write, including 5257 / 5259 Brooklyn and 4709A 8th
  Avenue, and no protected listing restore migration.
- No staging or dev data refresh, schema teardown, seed, wipe, or customer-data
  backup into the repository/workspace.
- No protected-branch push, application release, iOS/TestFlight distribution,
  or declaration that unresolved historical bundle parity is equivalent.

## Required confirmation and apply gate

The named scope and baseline fingerprints are now confirmed. The apply-capable
change must receive a fresh independent review after that confirmation.
Immediately before any eventual
apply, rerun the production read-only ledger/catalog/prerequisite checks and
refuse changed, partial, conflicting, or already-complete-but-unverified state.

No apply command or production-write environment flag is defined yet. Record
execution outcome here; one successful installation consumes this waiver.

## Initial apply review outcome

Fresh Astra review of the apply-capable candidate, script SHA-256
`c8226a43f34dc139bb2c2e410a9cc825befeee3b968011606d99cec00b2c29e3`,
returned **CHANGES REQUESTED** with three High and three Medium findings.
See `docs/plans/2026-09-11-production-migration-apply-review.md` and its
correction-1 plan. The actual CLI write connection's verified-TLS feasibility
must be resolved within the approved mechanism or returned as a planning
blocker. This candidate is not authorized for execution. Root launched a fresh
Sol-medium correction phase; the bundle remains unchanged and this waiver
remains **unconsumed**. No production SQL write or promotion has occurred.

Correction-1 feasibility result: fresh Sol and Terra independently confirmed
that the pinned CLI's required project-ref path cannot express verified
peer/hostname/CA trust for its write socket. Its verified DB-URL path is mutually
exclusive with project-ref. The approved operation is therefore **blocked by a
mechanism constraint**. Changing the transport requires Akhil's direction and
a revised reviewed implementation; this record does not authorize substitution.

## Approved transport amendment, September 11 2026

In response to the explicit question about revising this named waiver to a
certificate-verified PostgreSQL connection for the same unchanged twelve-source
bundle, Akhil answered: "okay can we finish up, do the prod migrations after
once more reviewing its safe (<5min) then work towards having it on prod so that
we can test changes on prod."

This approves replacement of the CLI project-ref WRITE mechanism with an
explicit PostgreSQL transaction over a pinned-CA, hostname-verified connection.
The named entrypoint, production target, twelve source files, 215925-byte bundle
and approved bundle SHA256 remain unchanged. CLI 2.117.0 may be used only for
read-only temporary credential acquisition against the fixed project. The
runner applies the unchanged bundle and auxiliary ledger identity in one
transaction; auxiliary statements store the complete bundle as one element,
not the old CLI parser representation. All original exclusions still apply.
This amendment supersedes only the old CLI-write/auxiliary-representation
requirements, not the data scope, safeguards, or final independent review gate.

Plan: docs/plans/2026-09-11-production-recovery-verified-transport-plan.md.
Final review is bounded to under five minutes as requested. The rejected
candidate cannot be run. Record the replacement fingerprint and review outcome
before execution; this waiver remains unconsumed until a successful install.

## Replacement approval and execution identity

Fresh independent Astra review approved the exact twelve-source operation on
September 11 2026, within the requested review timebox. Report:
`docs/plans/2026-09-11-production-recovery-verified-transport-review.md`.
Independent focused tests (39), actual disposable PostgreSQL/TLS rehearsal,
scoped lint, syntax, source and fingerprint checks all exited 0.

Final approved named runner SHA-256:
`178540a6f319c01e2c61696ec99d617189871f6c584c87643974d776c1c8e624`.
Pinned CA PEM SHA-256:
`700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
The approved bundle remains 215925 bytes with SHA-256
`9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.

The acknowledged command forms are now defined. Root may run read-only
`--preflight`, then one `--apply` only after operational gates pass, each with
`--waiver 2026-09-11-production-recovery-schema` and
`--bundle-sha256 9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
No production-write environment flag is used. This supersedes the earlier
preparation-phase statement that no apply command was defined. All scope
exclusions remain. No application promotion is approved by this waiver.

Root rechecked all five implementation/test/certificate fingerprints against
the handoff, exit 0. Fresh backup listing at approximately 06:49 UTC again
reported backup 1635565372 COMPLETED, created 2026-09-10T13:20:44.705Z,
PITR disabled. Remote keeper/main/staging/production references are unchanged.
This is provider backup status, not a restore test. Live preflight and execution
outcomes will be recorded below. The waiver is still unconsumed.

Production read-only preflight completed at approximately 06:53 UTC, exit 0:
`preflight_passed`, migrationCount 12, ledgerRows 163,
prerequisitesMissing 0, targetObjectsAbsent true; other client sessions 5,
active sessions 0, long transactions 0, lock waiters 0. This exercised the real
fixed-provider temporary login and verified TLS path without database writes.
Root is proceeding to one acknowledged apply using the unchanged reviewed
runner and bundle. An uncertain outcome must not be retried.

## Final execution outcome

Root invoked the acknowledged named runner once with `--apply`. It exited 0
by 2026-09-11 06:53:10 UTC and returned
`{"outcome":"success","migrationCount":12}`. Under the independently reviewed
runner contract, success requires a confirmed COMMIT and a fresh verified-TLS
connection validating the complete unchanged historical ledger, twelve exact
source ledger rows, one complete-bundle auxiliary row, and the exact catalog
and private-bucket safeguards. Both gates passed.

This consumes the one-shot waiver. Do not rerun the apply command. No application
operation, customer-record write, protected listing write, provider message,
other migration, Git promotion, Vercel deployment or iOS distribution was part
of this operation. The separate five newer migrations and application release
gates remain unresolved.
