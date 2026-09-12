# Release schema evidence and unresolved gate

Observed September 11, 2026, approximately 00:30-00:35 UTC. Read-only investigation by root Astra during Akhil's explicitly authorized release. This is a schema readiness finding, not a captain permission requirement.

## Verified deployment configuration

- Authenticated Vercel project API: `proplane`, project `prj_rupckw3T2v0oXVg2nTLVCYePKDUc`, production branch `production`, repository `PropLane`.
- Production target is READY at `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- Staging-scoped Preview `NEXT_PUBLIC_SUPABASE_URL` was inspected directly and its hostname is exactly `xwszcafaontidfgznlxd.supabase.co`. No credentials were printed or downloaded. The default Preview URL is not a safe substitute for this branch scope.
- Browser opened `https://staging-prop-lane.space/auth/sign-in` successfully using installed Chromium. This is the old staging deployment, not acceptance of the new code.
- Canonical dev QA accounts are absent from staging. No staging account was created or password reset. A dedicated account/phone was requested for real provider checks; do not use contacts copied from production.

## Read-only method

Used the existing `scripts/sync-prod-to-staging.mjs` CLI dry-run login pattern without running that script or taking a dump. For each exact project ref, the CLI dry-run output was captured in process memory, credentials extracted without printing, and the host/user ref validated. A PostgreSQL client opened `BEGIN READ ONLY`, used `SET LOCAL ROLE postgres`, queried migration history and catalogs, and rolled back. No application rows, DDL, migration repair, provider sends or production writes occurred.

The first catalog attempt without the required role returned `42501` and was not treated as evidence of missing objects. The role-scoped repeat succeeded. Diagnostic script is `/private/tmp/proplane-release-schema-readonly.mjs`, contains no secrets, and is outside git. Its object extraction is deliberately limited; object presence alone is not full schema equivalence.

## Timestamp mismatch is not proof of unapplied SQL

The integrated tree has 186 migration files. Strict version comparison reports staging missing one and production missing 44. This is partly false drift, exactly as `docs/database-environments.md` warns: history was rebuilt with apply-time bundled versions.

- Staging has every local migration NAME. `work_order_human_references` is recorded at `20260904121000`, while the repo renamed it to `20260904120001` for uniqueness. It must not be blindly reapplied.
- Production has 21 non-repo versions and bundled SQL. Normalized SQL for several missing-name migrations is present in bundles, including SMS contact email, manager SMS sessions, action event bus, manager communications billing, and invoicing. Inbox attachments also match the repair entry.
- Historical `work_order_events` tables were renamed by the later action-event migration. Their old names being absent is not current schema drift.
- The new `scripts/check-migration-parity.mjs` compares version strings only and does not reconcile this history. Its false positives must not be solved by pretending a missing connection string is a passing parity check.

## Genuine production omissions

Independent catalog checks found these current objects absent, with neither their own migration names nor equivalent normalized migration SQL in the inspected history:

- `public.webhook_subscriptions` and `public.webhook_deliveries` from `20260907130000_webhook_subscriptions.sql`.
- `public.account_deleted_record_identities`, `public.account_preserve_financial_records` and the associated financial identity protection functions.
- `public.account_recovery_requests`, `account_recovery_records`, `account_recovery_holds`, `account_recovery_dependencies`, and associated recovery functions including `account_recovery_begin`.
- The later account-recovery object retention and deleted-identity key tables/functions are also absent.

A separate direct `to_regclass` check returned NULL for both webhook tables, `public.account_recovery_requests`, and `public.account_deleted_record_identities`. This confirms the catalog finding is not merely information-schema privilege filtering.

The same read-only direct lookups on staging at approximately 00:58 UTC resolved all four relations successfully. Staging also has all local migration names. This isolates the confirmed omission to production rather than an invalid object-name probe.

The missing recovery/preservation group corresponds to the eleven repo migrations from `20260907214100_preserve_resident_financial_history.sql` through `20260907233000_account_recovery_finish_archival.sql`. Catalog absence is a concrete finding, not merely a ledger-name inference.

Current code references these objects: `src/lib/auth/account-recovery.server.ts`, `src/lib/auth/purge-portal-account-data.ts`, and `src/lib/webhooks/subscriptions.server.ts`. Recovery sign-in has an intentional missing-schema fallback, but deletion requests explicitly require the schema. This report does not claim the new tour fixes introduced the drift or that all live routes fail.

## Release decision

Hold production promotion pending a reviewed reconciliation plan and authority for the exact production database changes. Akhil authorized deploying code and removing captain handoff, not overriding the separate no-production-data-write rule. No migration was applied, no ledger was repaired, and no gate was disabled. Do not bulk replay the apparently missing 44 versions: bundled/applied migrations and protected listing restore migrations make that unsafe.

The missing recovery migrations are not harmless ledger bookkeeping. They install auth, public-table and storage triggers, alter financial constraints, create a storage bucket, and contain a deleted-identity key backfill. An explicit, reviewed production database scope is needed; do not infer that permission from the code deployment request.

Continue keeper validation and finish the requested Akhil instruction correction. Next issue implementation remains behind Akhil's requested ship-first checkpoint. Staging QA and controlled-handset acceptance are still outstanding independently of schema readiness.
