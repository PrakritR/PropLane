# Staging release execution — 2026-09-05

Scope: complete the build and staging release path, deploy compatible encryption code, validate synthetic browser/mobile flows, migrate existing staging values and enable strict reads. The user has now authorized production encryption rollout and production access hardening, followed by sensitive-copy protection and key recovery. No-mistakes remains explicitly excluded. Basic dev isolation supports this release; production onboarding protection is the objective.

## Completed preparation

- Committed the security implementation as `421a5709` and integrated current `origin/main` (`932f29d1`). Kept the shared asynchronous rate limiter and the newer independent assistant-denial quota; 44 focused integration-review tests passed.
- Restored remote `staging` from `origin/main` using `npm run ship:staging`. Baseline staging CI run `33983622811` passed build, lint, unit, integration and browser smoke checks. This verifies the restored baseline, not the new encryption candidate.
- Retrieved branch-scoped staging runtime settings privately and verified the staging URL. Retrieved and validated staging service credentials for maintenance without printing them. Keys remain separate from the database, with the prior Keychain recovery copies.
- Verified read-only rehearsals: calendar 21 scanned / 19 changed / 24 plaintext tokens; applicants 17 / 10 / 27 fields; documents 17 applications / zero candidates / zero protected objects. One concurrent applicant rehearsal failed generically; the original command and row-processing diagnostic both passed sequentially. Credential contention is plausible but unproven. Maintenance commands will run sequentially.
- Created an AES-256-GCM encrypted recovery snapshot of the 17 application rows, 21 automation-settings rows, zero co-signer rows and zero aliases. Decryption was verified in memory. Archive is private and gitignored under `.staging-prod-sync/security-backups/2026-09-05T18-26-33-569Z.json.enc`; ciphertext SHA-256 `4cdadef571756fd0b681a7895dd129c945e59f4389be7f0e492d10de3c463d0e`. No plaintext customer backup was written to disk. This is a bounded migration snapshot, not an organizational backup/restore certification.

## Build and review corrections

The build exposed a server-only token/encryption import through browser URL helpers. The URL helpers were split into `resident-setup-links.ts`; server-only enforcement remains on token persistence. Its 25 focused tests passed. A later build compiled successfully but rejected an optional API Request parameter during generated route typechecking. The signature and affected test were corrected.

Independent review also found a browser-only subscription invoked during shared-module initialization. Registration now runs only in the browser, with an import-time server regression and retained browser account-change tests (14 targeted tests passed). Workflow diagnostics tests now parse active YAML steps rather than matching raw text/comments (9 tests passed).

The old security-wrapper command had no implementation in reachable history; the [gate reconciliation](2026-09-05-release-gate-reconciliation.md) preserves mandatory security/Bugbot reviews and unresolved Critical/High blockers. No-mistakes run `01M1SCSVDD95GJDPYV33DHHMT2` was **cancelled immediately at the user's explicit instruction not to use it**. It did not pass and is not a remaining permission or release dependency for this authorized run. Its findings are being resolved through direct edits, independent reviews and tests; no pipeline fixes were discarded.

## Earlier checkpoint — superseded by execution below

The legacy application-ID/document-alias correction is implemented with atomic exact-snapshot normalization and reference migration. Its hosted dev/staging transaction probes each passed 10 checks and rolled back all fixtures. The integrated unit suite passed 1,144 files / 7,569 tests. The resumed final production-mode webpack build passed compilation, TypeScript and all 368 static pages. Changed-file lint passed with no errors and 16 existing hook warnings. Candidate landing, staging deployment, synthetic browser/mobile validation, actual backfill and strict-read cutover remain pending. Remote staging was absent again when work resumed; it will be recreated through the normal promotion script. Production runtime settings were read privately and the exact production Supabase URL verified; no production mutation has occurred yet.

## Completed execution update

Candidate `944e9e0b` was deployed to staging and passed the [focused component/HTTP QA run](2026-09-05-staging-security-qa.json), including Chromium and mobile WebKit. Synthetic fixtures were cleaned up. The harness tested actual upload components against deployed routes; full wizard-resume navigation, physical camera/Capacitor and live OAuth were not certified.

Existing staging backfills then encrypted 24 calendar tokens and 27 applicant identity fields. All four post-apply inventories reported zero plaintext/changed rows and zero legacy documents. Four strict flags were provisioned for staging; its strict deployment at `108b6533` is READY and [final strict-mode QA](2026-09-05-staging-strict-security-qa.json) passed, including deliberate plaintext rejection and fixture cleanup. Main/staging advanced concurrently in another workstream; no branch was forced or rewound. Production execution is recorded in the [current rollout report](2026-09-05-production-rollout.md).
