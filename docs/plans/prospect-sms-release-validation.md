# Integrated SMS release validation

2026-09-12, pool5 `prospect-sms-release`, base `b6085cd66e18da232640b4bc57d05e4499eb71a3`.

- Production build: exit 0. `/tmp/prospect-sms-release-build.log`.
- Full unit suite on Node 22.23.0: `NODE_OPTIONS=--max-old-space-size=4096 npm run test:unit -- --maxWorkers=2`, exit 0, 1,412 files and 9,932 tests passed in 331.60 seconds. `/tmp/prospect-sms-release-unit-bounded.log`.
- Earlier concurrent full unit and duplicate lint runs were stopped with exit 143 during memory pressure. They are not passing evidence. The bounded full unit run supersedes the incomplete unit run.
- Full integration-manager lint: exit 0, 719 existing warnings. Root reran ESLint on final changed runtime/callback and regression files after the narrow fixes: exit 0.
- TypeScript: exit 0. Lockfile verification: exit 0.
- Actual PostgreSQL: clean and repeat migration apply, 97 assertions, all exit 0. See `prospect-sms-db-probe.md` for exact SQL digest and evidence.
- Fresh Astra integration review cleared the duplicate-credit P1 and quiet-handoff P2 after behavioral regressions. No remaining blocker in the reviewed flag-off code scope. GPT scorer defect remains disabled and unresolved. See `prospect-sms-release-integration-review.md` and dated security reports.
- Integrated browser: real seeded open tour slots, mobile width, invalid property and anonymous portal redirect verified. Canonical-account public smoke: 10/10 passed, exit 0. See `prospect-sms-browser-qa.md`.
- `npm run ship:preflight`: exit 0, 11 checks and 4 warnings. This shell has no exported production credentials; its environment warnings are not evidence that deployed credentials are absent. Read-only environment-name inspection is recorded separately. Migration parity is not passed by this preflight result.
- Graph refresh remains unavailable because the installed legacy graphify tool lacks the required executable commands. No incompatible graph rebuild was performed.

## Migration parity blocks promotion

The dedicated Supabase read-only SQL endpoint returned HTTP 201 for both staging and production migration ledgers. Compared exact migration names using the repository's `diffMigrations` implementation. Artifact: `prospect-sms-release-migration-parity.json`. No shared schema or ledger write occurred.

Staging has four missing names: `sms_conversation_houses`, `portal_workspaces`, `vendor_business_profiles`, and `prospect_sms_bursts`. Both the repository and staging ledger contain duplicate `agent_pending_actions`; staging additionally has duplicate `resident_invite_links` and a remote-only `comms_billing_rollout` name.

Production has 22 unmatched names including `prospect_sms_bursts`, alongside historical bundled/repair migration names and duplicate `agent_pending_actions`. Unmatched names do not prove every corresponding schema object is absent: bundles require explicit reconciliation, not an assumed equivalence or blind replay. Fresh schema metadata separately proves this feature's burst tables/RPCs are absent.

Under `docs/ship-gate.md`, parity must be checked and resolved before promotion. The production SQL lock separately requires operator application of the reviewed feature migration. Release branch and main landing may proceed after code checks; staging/production promotion and feature activation remain blocked by the unresolved deployment gates and queue configuration. No production deployment is claimed.

## Subsequent authorization and reconciliation

Akhil explicitly removed the production-write prohibition and authorized reconciliation/application. The old lock and operator-only statements above describe the earlier checkpoint; they are superseded by `prospect-sms-migration-reconciliation.md`. Root captured private schema/ledger backups, verified all 21 production bundle identities with independent review, and prepared only five staging/two production DDL files. The corrective occupancy migration passed 12 actual PostgreSQL cases. The ledger runner passed 51 focused unit/parity tests plus actual PostgreSQL success and injected-failure rollback rehearsals for both captured ledgers. Application and deployment outcomes are recorded in the reconciliation handoff/release outcome, not inferred from rehearsal.
