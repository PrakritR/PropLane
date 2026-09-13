# Portal reliability release security re-review

Date: 2026-09-12. Reviewer: `security_review` subagent.

Worktree: `/Users/prakrit/firstmate/projects/proplane-portal-release-20260912`.
Reviewed release HEAD: `664221243e10c893b1f6d12bdf9fea6cf696666f`, a merge of live/main `7b3d464f` and previously reviewed feature/captain `b10f5f66`. The working tree was clean. This was a bounded integration and migration review, reusing the completed feature security/no-mistakes evidence; it was not another whole-feature audit.

## Conclusion

No new High/Critical code-security blocker was found in the integration. The four pending migrations are identical to the reviewed feature parent, and the current live SMS/workspace protection files were preserved byte-for-byte relative to `7b3d464f`.

There is a separate production-apply authorization condition: migration `20260912220000` is **not DDL-only**. Its top-level lines 40–41 execute an UPDATE of existing customer automation settings. Applying it without the bounded production permission/exception identified by the parent would violate the standing production-data restriction. This report does not authorize production application or waive staging, backups, target verification, schema parity checks, or iOS release checks.

## Apply-time effects of the four migrations

| Migration | Apply-time effect | Existing customer-row write |
| --- | --- | --- |
| `20260912210000_atomic_conversation_house_assignment.sql` | Defines service-only access revision and atomic tag-replacement functions; revokes public/client execution. | None. Embedded tag DELETE/INSERT runs only when its RPC is invoked later. |
| `20260912220000_tour_interest_reminders.sql` | Adds phone/cutoff columns, reminder constraints/index, activation trigger, service-only controls table, and reminder/cancellation/submission RPCs. | **Yes:** sets `manager_automation_settings.tour_interest_enabled_at=clock_timestamp()` where JSON `reminderRules.rules.tour_interest.enabled` is already `'true'` and the cutoff is null. It does not enable an automation or send a message. It may affect zero rows, but that has not been verified against production. |
| `20260912230000_vendor_directory_private_fields.sql` | Drops the vendor self-read policy exposing private directory JSON. | None. This narrows direct client read permissions. |
| `20260912233000_atomic_inbox_folder_changes.sql` | Defines service-only inbox folder and combined SMS-notice/follow-up mutations. | None during migration apply; the UPDATE statements are inside function bodies. |

None of the four top-level statements updates/deletes a property, listing, lease, payment, conversation or recipient record. No seed, live-listing repair, provider call, runtime-mode activation, or customer message is performed by applying these files. Routine PostgreSQL catalog/migration-history writes are of course part of schema application. Added CHECK constraints can reject pre-existing incompatible rows; this review did not query production or prove those rows absent.

Exact policy sources in this checkout: `AGENTS.md:53–57` requires explicit production authorization, exact target resolution, backup, a reviewed fail-closed apply path, and verification. `docs/agents/AGENTS-prakrit.md:173` separately says “Write production data, even when asked in chat” under “Do not.” The parent specifically reported that the bounded production-data exception has not yet been given. An unqualified “DDL only” approval would not describe migration 220000 accurately. The three locked listing rows are not touched by these apply-time statements.

## Integration evidence

- `git show --cc HEAD` has no combined conflict-resolution diff. `git diff b10f5f66..HEAD -- <four migration paths>` is empty.
- `git diff 7b3d464f..HEAD` is empty for `src/lib/agent/leasing-sms-agent.server.ts`, `src/lib/agent/prospect-gpt-shadow.ts`, `src/lib/agent/prospect-shadow-comparison.ts`, `src/lib/sms/prospect-sms-burst.server.ts`, `src/lib/workspaces/server.ts`, `src/app/api/workspaces/route.ts`, `src/lib/plan-addons.server.ts`, `src/app/api/manager/plan-addons/route.ts`, and `20260913001000_atomic_workspace_plan_limit.sql`. Thus the merge preserves read-only shadow tool filtering, burst publish deduplication, closed add-on purchase changes, unknown-plan failure, and atomic workspace limits already present in live/main.
- Read the new inbox-folder RPC call paths: authenticated routes resolve stored ownership/scope, reject missing members, distinguish SMS notices, and send authorized ids to service-only functions. Combined SMS folder mutation invokes the previously reviewed grant-revision/tag-check and cancellation boundary before changing inbox state. No new anon/authenticated execution grant is introduced.
- Reused earlier house/follow-up security evidence for strict owner/property grants, atomic tag replacement, server activation cutoff, archive/send exclusion, and final provider-boundary state checks. The service-only controls table retains account-purge classification.
- Verified the vendor privacy policy removal against explicit shared-directory projection coverage; it closes the raw private-JSON read path rather than broadening RLS.

## Targeted validation on the release HEAD

```text
npx vitest run tests/unit/sms-conversation-house-assignment-sql.test.ts tests/unit/tour-interest-reminder-sql.test.ts tests/unit/inbox-folder-route.test.ts tests/unit/vendor-catalog-privacy.test.ts
```

Exit **0**, **4 files / 39 tests passed**, 18:43:11 local. Log: `/tmp/proplane-release-security-tests.log`. The SQL suites use local in-memory PGlite; no live database, customer rows, provider/model calls, messages, seeds or tickets were involved. No repository files were edited and no commits/pushes were made by this reviewer. Full release build/browser/staging and production apply verification remain parent-owned.

## Migration SHA-256

```text
cdc12b5d8af2d286742e7053d78cd5be0e6a22a2cbc606b2df53ef9b82e3d08f  20260912210000_atomic_conversation_house_assignment.sql
5937d23cca3c921128409e7ec7b0e649f11c69b40f7c2898fc575e100b3a0f34  20260912220000_tour_interest_reminders.sql
ef936eba8f457d310e7173519d01cbef88205291361ba48d2b945b107311050e  20260912230000_vendor_directory_private_fields.sql
36151c07f984c0bf0b4edb6ab5304e160ff39c8a4237e428cdab4210c0794474  20260912233000_atomic_inbox_folder_changes.sql
```

## Addendum: guarded zero-row schema application

The parent proposed taking a table lock, asserting that no existing automation enables tour-interest follow-ups, and then applying the exact four migrations plus ledger entries in one transaction. **That is SQL-sound for guaranteeing this migration's customer-row UPDATE affects zero rows**, provided the following conditions hold:

1. Use one privileged connection and explicit `BEGIN ISOLATION LEVEL READ COMMITTED`. Acquire `LOCK TABLE public.manager_automation_settings IN SHARE ROW EXCLUSIVE MODE` before the assertion. Run the assertion as a subsequent statement, so it observes commits completed before the lock was acquired rather than an older transaction snapshot.
2. Assert `NOT EXISTS (SELECT 1 FROM public.manager_automation_settings WHERE row_data #>> '{reminderRules,rules,tour_interest,enabled}' = 'true')`. This is stronger than the migration's own predicate, which additionally requires a null cutoff. Raise an exception if any matching row exists. The assertion must see the whole table; a suitable migration role with full visibility and `SET LOCAL row_security = off` makes unintended RLS filtering fail closed.
3. Hold that same transaction through the exact reviewed bytes of all four migrations and their migration-ledger insertions. Do not commit between the assertion and the backfill; do not roll back the lock/assertion savepoint and then continue. Every error, hash mismatch, timeout or changed prerequisite must stop and roll back the complete apply.

PostgreSQL ordinary INSERT/UPDATE/DELETE operations acquire ROW EXCLUSIVE, which conflicts with this table lock; existing writers finish before the lock is acquired and new writers wait until transaction end. Consequently no concurrent session can enable a setting between the zero assertion and migration220000's UPDATE. DDL may need stronger locks and can wait or abort on timeout/deadlock; that does not weaken the zero-row guarantee. Sources: [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) and [Read Committed isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

The schema backup's existing automation recovery triggers are row-level. A zero-row UPDATE invokes neither those row triggers nor the newly defined row-level activation trigger. The migration still issues an UPDATE statement, but under this guard it changes no existing customer record; its remaining writes are schema/catalog/new empty-table and migration-history changes. This is a technical effect assessment, **not an authorization decision**; the parent must determine whether the user's explicit production-promotion request authorizes the schema application under the standing rules.

Latest local evidence read: `/tmp/proplane-release-production-backup.log` reports target `qahnczmilgptcedaqype`, `readOnly:true`, `enabledAutomationRows:0`, `ledgerRows:212`, schema627271bytes, backup directory `/tmp/proplane-release-prod-backup-1cK93H`. This differs from the earlier parent-supplied `Jdv2Od` directory; use the matching latest target/schema/ledger evidence as a unit. The preflight read alone is not the race protection: the in-transaction assertion is mandatory. No production apply or new production query was performed by this reviewer.

## Exact apply-script review

Read `/tmp/proplane-release-apply-reviewed-schema.cjs` without executing it (SHA-256 `0d849ecc0a33cdf501ef4d780cf2070d1ef1103038383178fa42e67df5b86077`). No High/Critical SQL/security blocker was found in this implementation of the proposed guard. It pins the production project host/user and CA fingerprint, enables TLS certificate verification, reads and hashes the exact four SQL files into memory before use, requires an explicit apply flag and saved zero-row/schema/ledger evidence, then uses one READ COMMITTED transaction with the full-visibility role and `row_security=off`. The automation lock remains held through the zero assertion and all DDL; an exclusive migration-ledger lock plus exact prior-ledger comparison rejects drift. Nonzero top-level INSERT/UPDATE/DELETE results abort, while only the four ledger INSERTs are intentionally permitted. Any pre-commit error rolls the transaction back. No provider or application-level send is called by the script.

Two bounded operational notes were sent to the parent: explicitly checking `PGDATABASE === 'postgres'` would complete the visible connection pin (the current value comes from the trusted project-scoped CLI response), and a result-file error after successful COMMIT cannot undo that commit. If post-commit output fails, verify the actual ledger/schema before retrying; the existing duplicate-ledger check already prevents blind repeat application. These are not reasons to weaken or skip any guard. The parent's production-authorization decision and staging QA remain separate from this technical review.
