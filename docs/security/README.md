# Security hardening and encryption rollout

**Status: implementation and nonproduction rollout in progress in `security/hardening-20260905`; application code is not deployed.**
Baseline: `f44f23a4`. This is a prioritized engineering review using Trail of Bits open-source tooling and methodology, not a paid Trail of Bits audit or a penetration test. Follow the existing [ship gate](../ship-gate.md); this document records security-specific dependencies, not a replacement release process.

## Priority and completion criteria

| Order | Work | Current status / completion evidence still needed |
| --- | --- | --- |
| 1 | Fix known vulnerable dependencies and exposed browser/server defaults | Local dependency audit has zero findings. Baseline CSP/framing/content-type headers, verified direct Postgres TLS, lease disclosure sanitization, strict TIN authentication tags and workflow shell-input fixes are implemented. Build, staging browser/native QA and live header checks remain release gates. CSP deliberately does not restrict scripts yet. |
| 2 | Make abuse limits work across Vercel instances | Migration applied and history recorded in dev and staging. Each hosted database passed a real 12-connection probe: 3 allowed, 9 rejected; browser grants/RPC access denied. Application callers and webhook outage handling are implemented locally; deployed HTTP/provider retry and sustained-load QA remain. |
| 3 | Provision separate encryption keys and encrypt integration credentials | Separate key rings and active IDs provisioned as sensitive Vercel Preview variables scoped to `main` and `staging`, with verified macOS Keychain recovery copies. Calendar encryption is implemented. Deploy compatible code before backfilling **both** token locations, verify zero plaintext, then enable strict reads. No production keys or existing-data backfills have been applied. |
| 4 | Encrypt applicant identity fields and remove residual copies | Canonical applicant SSN/DOB/license and co-signer masked SSN/DOB/license encryption, authorized readers/writers and backfills are implemented. Hosted dry-run rehearsals passed in dev/staging; existing records are unchanged. Applicant persistent browser mirrors are removed locally, with account-change/late-response/queued-write protection. Lease snapshots, generated exports and backups remain separate copies to cover. |
| 5 | Protect document contents against storage-export theft | Application upload/download encryption and legacy aliases/backfill are implemented; both document migrations are applied in dev/staging. A synthetic hosted dev probe verified encrypted replacement, authorized roundtrip, stable aliases, browser-role denial and cleanup. Existing customer objects are unchanged. CDN copies can outlive origin deletion. Manager/vendor/inbox/lease document byte paths remain outside this implementation. |
| 6 | Verify operational controls and test independently | Bounded production inspection confirmed private buckets and RLS on five tables, but found excess browser privileges, disabled direct database SSL enforcement and no verified MFA factors on the 23 application accounts. Privilege corrections and SSL enforcement are applied in dev/staging only. Cross-account tests, privileged MFA, key recovery, backup restore, telemetry privacy and an authenticated multi-role penetration test remain. |

Release validation, coverage of residual copies and operational controls remain substantial work. This implementation does not establish that all customer data is protected against a database export, compromised application or privileged account.

All 31 external GitHub Action references are now pinned locally to verified upstream commit SHAs, with weekly Dependabot maintenance configured. The workflows have not been deployed/run from this branch.

## What is already known about production

- Public `https://prop-lane.space` uses HTTPS and returns HSTS. Its observed response before these changes lacked the new browser headers.
- Supabase states that customer data is encrypted at rest with AES-256 and in transit with TLS: [provider security](https://supabase.com/security). This is provider assurance, not an independent inspection of our storage or a PropLane certification.
- Read-only `supabase ssl-enforcement get --project-ref qahnczmilgptcedaqype --experimental` reported direct database SSL enforcement **disabled**. HTTPS API traffic still uses TLS. Enabling enforcement may briefly restart the database: [official enforcement documentation](https://supabase.com/docs/guides/platform/ssl-enforcement). No production setting was changed.
- The [bounded production inspection](2026-09-05-production-control-verification.md) confirmed the two document buckets are private and RLS is enabled on five inspected tables. It did not validate policy expressions, storage object policies or end-to-end cross-account access. Application MFA enrollment was 0/23 accounts, including 0/1 explicit-role admin; provider/organization MFA was not inspected.
- Production application-key provisioning, TIN key configuration and backup restore remain unverified. Missing variables in a local shell do not prove that production variables are missing.

## Encryption design and limits

Infrastructure encryption protects storage media. A database query or logical export can still return readable values. The additional field layer encrypts selected values before database storage and holds the key separately in the application's server secret store. A database-only attacker lacking that key cannot decrypt those fields. A compromised application runtime with decryption access can; this is not end-to-end encryption or zero knowledge.

`DATA_ENCRYPTION_KEYS_JSON` maps key IDs to cryptographically random 32-byte keys encoded as base64; `DATA_ENCRYPTION_ACTIVE_KEY_ID` selects new writes. Never put these in `NEXT_PUBLIC_*`, a database table, source control, build logs or a chat. Use separate keys for dev, staging and production. The implemented adapter uses server environment secrets; a dedicated KMS with independently controlled decrypt permissions is the preferred subsequent key-management boundary and is not yet integrated. Key loss without a recoverable key backup loses access to ciphertext.

For rotation, retain old keys for reads, select a new active ID, re-encrypt existing records, verify migration, then retire the old key only after accounting for backups and recovery requirements. Existing TIN ciphertext still uses its legacy key format; strict tag checks are improved, but versioned rotation and record binding remain separate work.

Calendar plaintext reads are temporarily allowed for migration; new credential writes always require encryption. After the backfill, set `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS=true`. Do not enable it before migration. A lost-key/corrupt-record disconnect can erase credentials through the existing authenticated DELETE route without decrypting. The current error UI does not expose that recovery path; operator-assisted recovery is required.

## Staged rollout dependencies

1. **Done for dev/staging:** recovered CLI-managed ephemeral database access with verified TLS, provisioned the CA in branch-scoped Vercel settings, enabled database SSL enforcement in both nonproduction projects and verified reconnects. The old local static password is not repaired or used. A bundled public CA is available in `scripts/security/supabase-prod-ca-2021.crt`; its name identifies the provider certificate, not a production credential.
2. **Done for dev/staging:** applied all four migrations (shared limiter, document envelope bucket settings, private document aliases, sensitive-table browser privileges) with history verification. Checked browser/service-role permissions and concurrent quota behavior. The app fails closed if the limiter RPC is absent; production still requires schema prerequisites before dependent code.
3. **Keys provisioned for dev/staging:** branch-scoped `main` database URL/anon/service settings explicitly select dev; staging's URL was verified as the staging project. Encryption rings are separate per environment and not stored in the database. Exercise OAuth connect/refresh/sync/disconnect with synthetic accounts after compatible code deploys.
4. **Dry-run rehearsals passed; apply pending:** after compatible readers/writers are deployed, backfill calendar credentials, canonical applicant/co-signer identity and application documents. Check stale `row_data.google_calendar` even when the dedicated column exists. Verify zero plaintext and no pending rotation, then enable each strict-read flag and test again. The synthetic document probe observed a cached old plaintext response after origin deletion; verify cache expiration/purge before claiming legacy plaintext removal.
5. Run staging browser/native QA: login/reset, lease PDF and attachment previews, camera uploads, calendar flows, and abuse/error paths. Verify security headers on HTML and stricter attachment responses. Measure limiter database load and behavior under actual parallel connections.
6. Only after dedicated staging QA signs off, promote through the existing `main → staging → production` ladder. Production keys and schema prerequisites come first, compatible code next, then existing-data backfill and strict-read cutover. This patch's backfill deliberately refuses production writes; prepare/review the production procedure with QA evidence instead of bypassing that guard.

## Remaining execution order

1. Integrate with current `main`, complete a production build in an environment with sufficient memory/disk, and run the repository release gate. Remote `main` advanced from this worktree's `f44f23a4` baseline to `932f29d1`; remote `staging` was absent at the final check. Restore the QA branch through the normal promotion process after integration; never skip staging or force-push.
2. Deploy compatible code to dev/staging, exercise synthetic multi-role browser/native flows, apply the rehearsed legacy backfills, verify cache cleanup and enable strict reads. Do not exercise outbound integrations against copied customer records.
3. Cover identity copies in lease snapshots and generated documents before making a broad database-export protection claim. Review remaining private document categories, custom/free-text answers and retained backups separately.
4. After dedicated QA, provision production keys and schema, deploy compatible code, run a reviewed production backfill, then enforce encrypted reads. Enable production direct database SSL enforcement in a maintenance window after checking every direct client.
5. Enroll/enforce administrator MFA, verify provider-account MFA, test organizational key recovery/rotation and backup restores. Replace local recovery dependence with managed key access and a documented recovery process.
6. Resolve AI trace/replay/retention exposure and verify PostHog project masking/settings; run authenticated cross-account testing and an independent penetration test. Update customer claims only from completed production evidence.

### Backfill commands

Load the correct environment through the established secret-loading mechanism; do not paste secrets into a shell command. The npm script supplies the React server condition required by `server-only`:

```sh
npm run security:calendar-backfill           # dry-run, counts only
npm run security:calendar-backfill -- --apply # dev/staging only
npm run security:cosigner-backfill
npm run security:backfill-applicant-identities
npm run security:document-backfill
```

These default to dry-run; `--apply` is restricted to dev/staging. `SECURITY_DATABASE_CLI_LOGIN=1` obtains short-lived credentials through the authenticated Supabase CLI with explicit nonproduction target checks and verified TLS. Never print the CLI credential output. Calendar/identity applies use row-locking transactions; document replacement uses per-object transactions and verifies uploaded ciphertext before committing aliases and deleting originals. See each implementation report for recovery semantics. Take a recoverable backup first and schedule locked migrations for a quiet window. Old plaintext backups remain a retention/access-control issue after live rows are encrypted.

Strict-read flags, enabled only after their corresponding successful backfill: `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS`, `COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS`, `APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS`, and `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS`. All remain disabled for rollout compatibility.

## Review and evidence

- [Baseline data review](2026-09-05-data-security-review.md)
- [Differential security review](2026-09-05-differential-review.md)
- [Bugbot review](2026-09-05-bugbot-review.md)
- [Static analysis](2026-09-05-static-analysis.md)
- [Nonproduction execution evidence](2026-09-05-nonproduction-execution.md)
- [Action pinning and telemetry privacy review](2026-09-05-actions-and-telemetry-review.md)
- [Application document encryption](2026-09-05-application-document-encryption.md)
- [Applicant and co-signer encryption boundaries](2026-09-05-applicant-identity-boundaries.md)
- [Production control verification](2026-09-05-production-control-verification.md)
- [Customer wording and claim gates](customer-security-wording.md)

The final full unit run passed **1,137 files / 7,512 tests** on Node 22 with three workers. Final standalone TypeScript checking passed. Final changed-file lint passed with **0 errors / 0 warnings**; the final npm audit reports **zero vulnerabilities**. Hosted dev/staging limiter probes passed using 12 independent connections each. Calendar/applicant/co-signer hosted dry runs succeeded, and the synthetic dev document probe verified roundtrip/alias behavior and fixture cleanup. These checks do not replace deployed browser/native QA, external integration tests or a penetration test.

The default Turbopack build failed from local `ENOSPC`; an initial webpack retry was terminated under resource pressure. The final webpack attempt, with documented memory optimizations and a 1,536 MB heap cap, exhausted the JavaScript heap (SIGABRT). This is a resource failure, not a passed build or a diagnosed source compile error. Production build and browser/native QA remain **incomplete**. `ship:preflight` failed on missing `origin/staging`; its environment warnings came from an unloaded local shell and do not establish production outages. The required `bin/fm-proplane-security-review.sh` is absent in this checkout; the security/bugbot reports do not silently substitute for a missing gate. The requested graph refresh also could not run with available tooling. All code is uncommitted in the isolated worktree; no production migration, backfill, key provisioning, push or deployment occurred.
