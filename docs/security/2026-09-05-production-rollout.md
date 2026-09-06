# Production security execution — September 5–6, 2026

## Live encryption and access controls

The reviewed encryption application revision `944e9e0b8c55a8a1c1c6faceabdaf04515acb046` was deployed through main and staging, passed focused deployed staging QA, then was promoted fast-forward from the prior production revision. Its production deployment was `dpl_7PFdsMe5EcGL24dWMYBAS5cAaFbx`. A separate workstream subsequently advanced production to `108b6533d11c30173fab0ea2f2b5009c8bb89b8c`, deployment `dpl_5ts881fzK8V4urM9CHYxfgSK86S3`, confirmed READY and serving the canonical alias. We preserved that advancement. This report does not supply broader QA approval for the other workstream's changes.

Before migration, provisioned a separate production keyring/active ID and verified its local Keychain recovery copy. Enabled direct PostgreSQL SSL enforcement and verified a certificate-validated reconnect. Installed all five reviewed migrations with matching history and boundary checks, including restricted browser grants. No master keys or customer field values were logged.

The installer initially rolled back on an unexpected PostgreSQL `name[]` parser shape. A read-only check confirmed no partial migrations. Casting catalog attribute names to text fixed verification; hosted staging validation then passed, and the production transaction successfully installed and verified all five migrations.

| Backfill | Scanned | Changed | Post-apply result |
| --- | --- | --- | --- |
| Calendar credentials | 21 rows | 19 rows / 24 plaintext tokens encrypted | 0 changed / 0 plaintext |
| Applicant identity | 24 rows | 14 rows / 39 plaintext fields encrypted | 0 changed / 0 plaintext |
| Co-signer identity | 0 rows | 0 | 0 changed / 0 plaintext; synthetic staging path tested |
| Application documents | 24 applications | 12 objects migrated | 12 protected envelopes authenticated; 0 legacy candidates, 0 cleanup pending, 0 deleted-parent discrepancies |

All applies wrote and authenticated private encrypted recovery archives before mutation. A subsequent offline authentication/checksum pass verified all four archives, including the 12 original document byte hashes. A separate authenticated Storage download check found none of those 12 old plaintext paths readable, with no unexpected errors. This checks those requests at that time, not every CDN edge or previously downloaded copy. The earlier dev probe demonstrated that caches can outlive origin deletion.

[Aggregate machine-readable evidence](2026-09-05-production-encryption-evidence.json) contains counts and ciphertext archive hashes only. Private archive paths, original object names, customer values and keys remain outside Git. Archive authentication using the configured key is not an independent key-recovery or database/object restore drill.

## Strict-read cutover

All four strict flags were configured for staging after its zero-plaintext backfills. The strict staging deployment `dpl_B4C2FCgGz52keVqTbDenYT3r6o5C` is READY at revision `108b6533`; its encryption and upload-component sources match the reviewed revision. [Strict-mode staging browser/HTTP QA](2026-09-05-staging-strict-security-qa.json) passed, including deliberate plaintext applicant rejection, authorized encrypted roundtrips and synthetic cleanup. All four production flags were then configured true, and a production redeploy of the current `108b6533` release was started. Final deployment readiness is pending.

## Release validation

The earlier [compatibility staging evidence](2026-09-05-staging-security-qa.json) records real upload components against deployed routes in Chromium and mobile WebKit, owner/foreign/anonymous checks, encrypted identity and document roundtrips, retry, malformed-envelope rejection and exact synthetic cleanup. A full wizard-resume test encountered unrelated navigation behavior; the focused harness deliberately makes no full-wizard claim. Physical camera/Capacitor and live OAuth provider flows were not tested.

The integrated unit run passed 7,569 tests in 1,144 files; the final production build and TypeScript passed. Main CI at test-only follow-up `9184d14e` passed all jobs after one browser-smoke rerun. New production operators passed 20 schema tests and 9 backup/backfill tests. The initial production release's TestFlight workflow `34002482242` completed successfully, including the TestFlight job. Later workstream builds are outside that result.

Canonical production checks returned sign-in 200 and unauthenticated applications 401, with CSP and HSTS present. Shared rate limiting and additional browser headers are deployed. These checks do not constitute a full production penetration test or universal tenant-isolation proof.

## Unfinished access and recovery work

Administrator MFA commit `83f88b8c` is prepared on local branch `security/admin-mfa-20260905`. Its 47 focused tests, TypeScript and lint passed, but final independent follow-up review and deployed QA did not complete before subagents exhausted the account usage allowance. It is not deployed, and administrators still need enrollment and recovery verification before enforcement. Provider-account MFA remains unverified.

Continue with [remaining sensitive copies and recovery readiness](2026-09-05-recovery-readiness.md). Lease/generated-document copies, other storage categories, traces/eval datasets, actual analytics privacy settings, independently controlled recovery keys and a full restore/rotation drill remain open. Open-source Trail of Bits tooling was used; no Trail of Bits audit or security certification is claimed.
