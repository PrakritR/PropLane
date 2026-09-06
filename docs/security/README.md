# Security hardening and encryption rollout

**Status: production encryption is live; existing covered data has been migrated and verified. Strict-read cutover is in progress. Administrator MFA is prepared but not deployed or enrolled.**

Updated September 5, 2026 (execution continued September 6 UTC). Initial security release: `944e9e0b8c55a8a1c1c6faceabdaf04515acb046`. This candidate passed deployed staging QA before promotion. Another workstream subsequently advanced production to `108b6533`; strict-mode staging QA passed on that revision and its production redeploy preserves it. The user explicitly excluded no-mistakes; direct reviews and validation were used.

## Current priorities

| Priority | Completed | Remaining |
| --- | --- | --- |
| **1. Production encryption** | Separate production key; compatible application deployed; five security migrations verified; 24 calendar tokens in 19 rows, 39 applicant identity fields in 14 rows, and 12 application documents migrated. Post-migration inventories report zero plaintext fields and zero legacy document candidates/cleanup pending; all 12 stored document envelopes authenticate. | Strict-mode staging QA passed; production strict redeploy is building. Independent organizational key recovery and rotation remain priority 4. |
| **2. Production access hardening** | Direct PostgreSQL SSL enforcement enabled and verified after reconnect. Sensitive application/co-signer/calendar tables deny direct browser access; alias/limiter tables and RPCs have restricted grants. New browser headers and shared database-backed rate limiting are deployed. Staging checks verify owner access and unrelated-manager/anonymous denials for the covered application/document paths. | Review and stage the prepared administrator MFA change, then have administrators enroll and verify recovery before enforcement. Provider-account MFA, wider multi-role authorization testing and sustained/provider-retry load checks remain. |
| **3. Remaining sensitive copies** | Applicant persistent browser mirrors removed in the deployed code. A scoped follow-up inventory is documented. | Lease snapshots, generated PDFs/exports, other document categories, free-text answers, retained backups, AI traces/eval datasets, and actual PostHog replay/masking/retention settings. |
| **4. Recovery and independent validation** | Encrypted migration archives were authenticated before writes; local Keychain recovery copies were verified. Dependency audit: zero findings at the reviewed revision; source/review reports retained. | Independently controlled key escrow/KMS, provider-backup verification, isolated database-plus-object restore, rotation drill and authenticated independent penetration testing. |

The encrypted identity scope is canonical applicant SSN/date of birth/license and co-signer masked SSN/date of birth/license. Production currently has zero co-signer submissions, so co-signer encryption was exercised with synthetic staging fixtures. The document scope is application-uploaded documents. This does not mean every database field, lease snapshot, document category, export or historical copy has application-level encryption.

## Verified production controls

- Production `qahnczmilgptcedaqype` has a separate versioned AES-256-GCM keyring in server secrets, separate from the database and nonproduction keys. No master key is exposed through public environment variables.
- Five migrations are installed with exact source/history and boundary verification: shared rate limits, document envelopes, document aliases, browser privilege restrictions and atomic application-record normalization. Profile row privileges were preserved while dangerous table-level grants were removed.
- Direct database SSL enforcement is enabled; the operator reconnect verified TLS certificates. Website HTTPS/HSTS and new CSP headers were observed live; sign-in returns 200 and unauthenticated application access returns 401. CSP deliberately does not restrict scripts yet.
- The two inspected document buckets are private. RLS was confirmed on five inspected tables; this is a bounded check, not universal policy certification.
- Separate encrypted pre-migration archives cover four selected tables and, for the document migration, the 12 original objects. These are bounded migration backups, not a tested full production restore system.
- Initial application MFA enrollment was 0/23 accounts, including 0/1 explicit-role administrator. The prepared MFA commit `83f88b8c` is retained on local branch `security/admin-mfa-20260905`; it is not deployed or claimed as an active control.

[Production execution evidence](2026-09-05-production-rollout.md) contains aggregate counts and deployment state. [Customer wording](customer-security-wording.md) limits claims to supported scope.

## Encryption design and limits

Supabase states that stored customer data is encrypted at rest with AES-256: [provider security](https://supabase.com/security). Infrastructure encryption protects storage media; a logical database export can still reveal unencrypted values.

The additional application layer encrypts designated values before storage and binds ciphertext to its purpose/record context. A database/storage copy without the server key cannot decrypt the covered ciphertext. A compromised application runtime or authorized account may still access decrypted data. This is not end-to-end encryption or zero knowledge.

`DATA_ENCRYPTION_KEYS_JSON` maps key IDs to random 32-byte keys; `DATA_ENCRYPTION_ACTIVE_KEY_ID` selects new writes. Keep these out of source, logs, browser configuration and database tables. Current server secrets plus a local Keychain copy are not independent organizational recovery or a dedicated KMS.

Rotation must preserve historical keys for live ciphertext and retained backups until migration/retention permits retirement. Existing TIN encryption uses a separate legacy key format and needs its own recovery/rotation work. Old plaintext backups and CDN copies require retention/expiry verification even after live origin cleanup.

## Validation and operational limits

- Integrated unit suite: **1,144 files / 7,569 tests passed**; production webpack build, TypeScript and 368 static pages passed. Changed-file lint: zero errors, 16 existing hook warnings. Dependency audit: zero findings.
- Main CI at test-only follow-up `9184d14e` passed all jobs after one browser-smoke rerun. The follow-up synchronizes the existing PDF loading test; production application code remains the reviewed `944e9e0b`.
- Hosted staging QA exercised real upload components and deployed HTTP paths in Chromium and mobile WebKit: 15 MB PDF, image replacement/reload, retry, authorized byte roundtrip, encrypted storage, corrupt-object denial, cross-account denials and co-signer identity encryption. Synthetic fixtures were cleaned up. This was focused component/HTTP QA; full wizard resume, physical camera/Capacitor, live Google OAuth and every portal role were not certified.
- Dev/staging shared-limit probes used 12 independent connections each: 3 allowed, 9 rejected. Production sustained load/provider retry behavior still needs validation.
- New production operators passed 20 schema tests and 9 focused backup/backfill tests; the schema installer was checked against actual hosted catalogs. Security subagents completed bounded reviews, then exhausted the account usage allowance; the final MFA follow-up review did not complete and was not retried.
- Trail of Bits open-source rules/methodology were used in our review. This is **not a paid Trail of Bits audit, penetration test or certification**. Graph refresh tooling was unavailable; it is not reported as passed.

## Maintenance and next steps

Use the fixed-target production operators in `scripts/security/production-schema.mjs` and `production-backfills.ts`; default behavior is read-only. Apply requires exact production confirmation and an absolute private encrypted-backup directory. Serialize ephemeral database-login operations. Keep private runtime/key files and migration archives out of Git and logs.

The four strict flags are `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS`, `APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS`, `COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS`, and `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS`. Enable only after zero-plaintext backfills and compatible-reader verification; environment updates require a deployment.

The lowest-cost maintainable next step is the existing shared MFA gate, followed by one shared sensitive-copy/encrypted-artifact policy and a bounded recovery drill. Do not build a second authentication or encryption framework. See the [prepared MFA rollout](2026-09-05-admin-mfa-rollout.md) and [recovery readiness and copy inventory](2026-09-05-recovery-readiness.md).

## Evidence

- [Baseline review](2026-09-05-data-security-review.md), [differential review](2026-09-05-differential-review.md), [Bugbot review](2026-09-05-bugbot-review.md), [static analysis](2026-09-05-static-analysis.md)
- [Production controls](2026-09-05-production-control-verification.md), [staging execution](2026-09-05-staging-rollout.md), [staging QA evidence](2026-09-05-staging-security-qa.json), [dedicated release review](2026-09-05-dedicated-release-review.md)
- [Document encryption](2026-09-05-application-document-encryption.md), [identity boundaries](2026-09-05-applicant-identity-boundaries.md), [telemetry review](2026-09-05-actions-and-telemetry-review.md)
