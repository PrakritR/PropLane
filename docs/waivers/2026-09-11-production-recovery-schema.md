# DRAFT waiver: 2026-09-11 production recovery schema

Status: **DRAFT - NOT APPROVED AND NOT AN APPLY AUTHORIZATION**

This document records the proposed named, one-shot scope required by
`.cursor/rules/no-production-data-writes.mdc`. Preparing or reviewing this
draft does not approve it. A human must explicitly confirm this exact waiver
after the script, generated bundle, local CLI rehearsal, and fresh production
readback have been independently reviewed.

## Proposed one-shot scope

Named script:

`scripts/prepare-20260911-production-migrations.mjs`

Target: production Supabase project `qahnczmilgptcedaqype` only.

Correction-cycle-1 candidate, still subject to fresh review and confirmation:

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

- This preparation-phase script rejects `--apply`; this draft does not enable it.
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

Before this draft can become an active one-shot waiver, the approver must name
`2026-09-11-production-recovery-schema` and confirm the reviewed script SHA and
the exact generated bundle digest. The apply-capable change must receive a fresh
independent review after that confirmation. Immediately before any eventual
apply, rerun the production read-only ledger/catalog/prerequisite checks and
refuse changed, partial, conflicting, or already-complete-but-unverified state.

No apply command or production-write environment flag is defined in this draft.
