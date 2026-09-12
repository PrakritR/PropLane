# Migration preparation: fresh prerequisites and CLI evidence

Root Astra, September 11 UTC 2026. Read-only observations during the September 10 local work session. Keeper HEAD `daddb7b5de9910ed3f140ff7d9a63beef48b0547`. These are diagnostic findings, not a production apply approval.

## Fresh remote observations

Both exact targets were queried using the secret-in-memory CLI dry-run login pattern documented in `2026-09-10-akhil-release-schema-evidence.md`. Each SQL connection used BEGIN READ ONLY, SET LOCAL ROLE postgres, bounded connection/statement timeouts, and ROLLBACK. No application record payloads, credentials, provider sends or production writes. The temporary script `/private/tmp/proplane-release-schema-readonly.mjs` prints metadata only.

- Production `qahnczmilgptcedaqype`: the four representative webhook/recovery tables remain absent. All 13 inspected prerequisites exist: the five financial guard targets, audit_log, vendor_invoices, vendor_payouts, profiles, profile_roles, auth.users, storage.objects, storage.buckets.
- All 115 ordinary public tables have primary keys. No account-prefixed lifecycle trigger exists. The account-recovery storage bucket is absent.
- All four vendor invoice/payout manager/vendor ownership FKs currently reference auth.users with ON DELETE CASCADE, and all four columns are NOT NULL. audit_log.actor_user_id is also NOT NULL. The proposed migration changes precisely these properties to nullable / ON DELETE SET NULL.
- Staging `xwszcafaontidfgznlxd`: all four representative tables resolve; all local migration names are present. All 129 ordinary public tables have primary keys. There are 244 enabled account-prefixed triggers across public/auth/storage, none disabled. The account-recovery bucket exists and is private.
- Staging's four ownership FKs already use ON DELETE SET NULL; the four columns and audit actor are nullable. Other invoice FKs (bill_id, decided_by) remain SET NULL in both environments.
- Read-only Git remote check: main and production remain `2d1353af42c3a652be6cf8a69640468b453f4cea`; keeper remains `daddb7b5de9910ed3f140ff7d9a63beef48b0547`; remote staging is absent. No promotion occurred.

This is catalog/prerequisite evidence, not full schema equivalence, production-sized lock testing, staged app QA or recovery/provider acceptance.

### Name-identity ambiguity found by the corrected checker

The fresh read-only staging ledger has 187 rows and zero missing repository names. Its additional row is a second `resident_invite_links` occurrence, not an unrelated extra name. Both the repository and staging also contain two `agent_pending_actions` migrations. Local `20260713000000` creates the original table; `20260716090000` widens portal/session fields, so those two source files are not equivalent. Counting one matching name as proof of both would be unsound. These ambiguities are reported fail-closed and require an explicit identity/equivalence follow-up before a green parity verdict.

Production still has 163 ledger rows and 33 missing local names, including the confirmed 12 omissions and the older bundled-history cases. The diagnostic is not permission to execute all 33 or change historical files. The one-shot preparation checks the 12 exact target identities independently and leaves unrelated history untouched.

## Pinned CLI behavior

`npx -y supabase@2.117.0 --version` returned `2.117.0`, exit 0. The unqualified installed `supabase` is older and must not substitute for this pin.

The pinned `db push --help` supports `--project-ref`, `--workdir`, `--dry-run`, `--skip-vault`, `--include-all`, optional roles/seed flags. Never include roles or seed; always skip vault for this scoped operation. A production dry-run must not be replaced with a generic repo-wide push.

Official source at the pinned tag was inspected with authenticated read-only GitHub API calls:

- [Migration apply implementation](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/legacy-migration-apply.ts): execMigrationBatch parses the file, batches compatible statements and appends the version/name/statements ledger insert to the final batch. Authored BEGIN/COMMIT or a transaction-mode-none directive switches execution to sequential behavior; the ledger insert is then outside the authored transaction. Therefore the prepared bundle must not author transaction boundaries or nontransactional statements.
- [PostgreSQL batch driver](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/legacy-db-connection.sql-pg.layer.ts): LegacyPgBatchQuery emits Parse/Bind/Describe/Execute for all statements followed by one Sync (lines 277-311), giving compatible statements and their ledger insertion the same implicit transaction. This is source evidence; the actual installed CLI still needs a local failure/rollback rehearsal.
- [Push core](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/legacy-db-push-core.ts): the dryRun branch reports pending files without applying; the apply branch updates vault only if includeVault is enabled, then applies migrations. `--skip-vault` avoids unrelated secret configuration changes.

The CLI creates/uses its own migration history table before file execution. That preexisting table is not evidence that a failed bundle committed. Verify absence of the bundle row, all 12 original-name rows and newly installed objects in the injected-failure rehearsal.

## Remaining boundary

The explicit named-waiver requirement in `.cursor/rules/no-production-data-writes.mdc` is still in force. General chat approval to prepare the rollout is not a self-issued waiver. Preparation, local rehearsal and review can proceed; production mutation must wait for confirmation of the exact named scope and its reviewed apply path.
