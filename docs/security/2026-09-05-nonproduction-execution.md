# Nonproduction security execution — 2026-09-05

These are actual nonproduction configuration/schema changes, distinct from the uncommitted application implementation. No production key, schema, data, deployment or setting was changed.

## Keys and environment isolation

- Provisioned `DATA_ENCRYPTION_KEYS_JSON` and `DATA_ENCRYPTION_ACTIVE_KEY_ID` as sensitive Vercel Preview variables separately scoped to branches `main` and `staging`. No shared or production encryption key was added or overwritten.
- Generated independent random 32-byte keys. Verified recovery copies in macOS Keychain: service `PropLane Data Encryption dev`, account `dev-20260905`; service `PropLane Data Encryption staging`, account `staging-20260905`. Temporary working copies are gitignored, mode 0600. Do not paste or log their contents. These are not an independent KMS or a tested organizational recovery process.
- Added explicit development URL/anon/service-role variables for Preview branch `main`, using locally validated development API credentials. This avoids relying on the broad Preview defaults. The Vercel CLI marked all new variables sensitive, including the public URL/anon key, so decrypted API read-back is unavailable; the supplied source URL was verified as development before provisioning.
- Read-back of the existing staging URL confirmed `xwszcafaontidfgznlxd.supabase.co`.
- Provisioned `SUPABASE_DB_SSL_CA` in both branch scopes. Bundled the public Supabase Root 2021 CA from the official Supabase CLI repository; SHA-256 certificate fingerprint `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, expiry 2031-04-26. This is a public trust certificate, not key material.

## Hosted limiter schema and concurrency

Ran `scripts/security/prepare-nonproduction-database.mjs <ref> --apply` after independent source review and an 8-case no-cloud harness. Only `emstjswhotsnyksqhqyf` (development) and `xwszcafaontidfgznlxd` (staging) are accepted by the command.

Both projects initially lacked the limiter table/function/history version. Both now contain migration `20260906020000_shared_rate_limits.sql` with exact SQL recorded in migration history. Verified RLS, all 14 combinations of browser-role table privileges denied, browser RPC execution denied, and service-role CRUD/RPC access granted. Each project passed 12 real parallel connections at limit 3: **3 allowed, 9 rejected**. Synthetic probe rows were cleaned up; the probe keys avoid opportunistic cleanup of unrelated buckets.

The client-to-pooler connection used certificate-verified TLS. A pooler's backend `pg_stat_ssl` entry is a different connection and was not misreported as the client's transport. This is not a sustained-load benchmark or a deployed HTTP/webhook test.

## SSL enforcement and existing data

Enabled direct database SSL enforcement via Supabase CLI in both dev and staging; each update returned `database: true` and `appliedSuccessfully: true`. Verified certificate-checked reconnects afterward. Production was not altered.

Read-only aggregate inspection found 30 application rows / 2 co-signer rows in development and 17 / 0 in staging. Both application-documents and manager-documents buckets were private. Staging's dedicated calendar column contained 5 nonempty refresh tokens and 19 nonempty access tokens, with zero refresh-token encryption envelopes. Development uses the calendar JSON fallback; that initial dedicated-column count does not cover its tokens. No token or customer field value was printed or exported.

Existing-customer-data encryption backfills have **not been applied**. They must wait until compatible readers/writers are deployed, otherwise the older running application would attempt to use ciphertext as credentials or identity fields. Staging may contain copied production records; use synthetic accounts/documents for feature tests and do not initiate calendar sync, screening, mail or SMS against copied customer records.

## Document schema and privilege corrections

Applied `20260906030000_application_document_envelopes.sql`, `20260906031000_application_document_aliases.sql`, and `20260906040000_sensitive_table_browser_privileges.sql` in both dev and staging with migration history recorded. The application document bucket remains private and accepts encrypted octet-stream envelopes up to 15 MB plus 4 KB. The alias table has RLS, no browser-role privileges and service-role access.

Verified all 42 browser privilege combinations across the three server-only application/co-signer/automation tables are denied, while the two profile tables retain SELECT and no longer grant browser TRUNCATE/REFERENCES/TRIGGER. Service access remains available. These changes have not reached production.

## Hosted backfill rehearsals

Executed actual read-only CLI-backed dry runs with verified TLS and aggregate-only output. The counts describe the inspected environment, not a production inventory.

| Target | Backfill | Scanned rows | Rows needing encryption/rotation | Plaintext values |
| --- | --- | ---: | ---: | ---: |
| Development | Calendar | 101 | 7 | 7 tokens |
| Staging | Calendar | 21 | 19 | 24 tokens |
| Development | Co-signer identity | 2 | 2 | 6 fields |
| Staging | Co-signer identity | 0 | 0 | 0 fields |
| Development | Canonical applicant identity | 30 | 30 | 90 fields |
| Staging | Canonical applicant identity | 17 | 10 | 27 fields |

Strict-read flags remain disabled. These successful dry runs do not establish a completed migration.

## Synthetic document probe

`scripts/security/probe-application-document-dev.ts` used the guarded development target, an existing canonical test manager, one synthetic application and a tiny synthetic PDF. The probe passed ciphertext roundtrip, stable legacy alias resolution, anonymous alias denial, origin object deletion and exact fixture cleanup. No auth account was created or customer object altered. [Sanitized results](2026-09-05-application-document-dev-probe.json).

The first attempt correctly exposed a verification caveat: an ordinary Storage download still served cached original bytes after deletion. The successful probe checked authoritative `storage.objects` absence and a fresh cache-busted authenticated GET returning 404. This establishes origin cleanup, **not immediate global CDN erasure**. The [first-attempt evidence](2026-09-05-application-document-dev-probe-first-attempt.json) is retained; cache expiry/purge remains a legacy-cutover requirement.

## Remaining verification

Final full unit suite: 1,137 files / 7,512 tests passed. Changed-file lint: zero errors/warnings. Dependency audit: zero vulnerabilities. The production build remains blocked by local disk/memory limits; browser/native QA and actual customer-data backfills remain outstanding. Remote `staging` is absent and `main` has advanced from this worktree's baseline, so integration and restoration of the QA promotion path precede release. Production rollout remains gated by the established main → staging → dedicated QA → production process.
