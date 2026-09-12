# Billing apply and temporary release exception

September 11, 2026. Akhil explicitly requested applying billing migrations and
omitting staging for the next few days. The dated exception ends September 15,
2026 at 04:00 UTC (midnight Eastern). The existing request to ship the prospect
improvement remains active; staging omission does not waive remaining checks.

## Production billing result

Reused the existing six-source package from main 490964121, including the
canonical account-recovery trigger correction. Fresh independent Astra review
`/root/billing_apply_review` found no blocking defect and matched the immutable
runner, preparer, bundle and correction hashes. Runner SHA-256:
`56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`.
Bundle SHA-256:
`c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.

The four existing migration unit files, including the mandatory disposable
PostgreSQL harness, passed: exit 0, 33 tests, 16.25 seconds. Fresh fixed-runner
production preflight passed: six sources, 176 historical ledger rows, zero
active sessions, long transactions and lock waiters. Clean schema absence,
compatible manual_payments, zero qualifying backfill and prerequisites passed.

Vercel project metadata and current READY deployment
`dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T`, production SHA
`2d1353af42c3a652be6cf8a69640468b453f4cea`, omit the legacy invoicer flag from
runtime/build inventories. The deployed helper returns before DB/provider work
unless the flag is exactly 1. Candidate helper is retired. Restrict rollback to
this exact verified disabled deployment. No environment or provider operation
was performed. Latest production backup metadata: COMPLETED, id1645439535,
2026-09-11T13:14:54.732Z; WALG enabled, PITR disabled.

Named waiver `2026-09-11-production-comms-billing` recorded current authorization
and received an independent readiness review. Its initial APPROVED - NOT
CONSUMED spelling failed the local parser before credential acquisition or any
DB connection. Root corrected the status to APPROVED. The following single
actual transaction returned exit 0:

```
node scripts/apply-20260911-comms-billing-migrations.mjs --apply-production --bundle-sha256 c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff --waiver 2026-09-11-production-comms-billing
{"outcome":"success","target":"production","migrationCount":6}
```

Root marked the waiver CONSUMED at 2026-09-11T20:07:28Z. The runner confirmed
COMMIT plus fresh-connection catalog/ledger verification. A separate subsequent
`--verify-production` invocation also exited 0 with outcome verified, six
migrations. No uncertain transaction was retried. No payment, provider send,
listing write, account operation or payment-preference backfill was executed.

## Temporary policy review

Fresh Astra reviewer `/root/direct_release_final_review` found no remaining
blocking issue after deterministic-clock tests and a second expiry check after
preflight were added. Independent policy/routing tests: exit 0, 16 tests.
Independent quiet handoff/tour integration spot checks: exit 0, three files,
nine tests. Shell syntax and diff checks: exit 0. Merge inspection confirmed
tour accepted-proposal precedence, channel scoping and quiet outbox suppression.

The initial documentation edit was rejected by automatic approval review as
weakening the staging gate. An evidence-supported retry supplied the user's
exact current instruction and fixed expiry; the narrow exception was accepted.
No fallback tool was used to evade that rejection.

Generic ship preflight exited 0, 11 checks and four warnings: dirty tree,
production secrets absent from the local shell, generic migration parity not
connected, Langfuse env absent. Its output is not proof of live env completeness
or all-history schema parity. The specific production billing operation above
was separately verified. Historical full-E2E failures remain historical failures,
not passes conferred by this bounded review.

## Application release status at this checkpoint

Production application remains 2d1353af; database apply is not a code deployment.
Current main 490964121 hosted Test run34639031770 passed build, lint, integration
and public smoke, but unit failed because its shallow checkout lacks immutable
migration Git sources and Linux OpenSSL rejects --version. A four-file repair
already exists in pool 3; it is being reused into the prospect keeper without
mutating that workspace. Final hosted checks must be observed before promotion.
The separate original-workspace prospect evaluation-loop changes remain excluded.


## Final code review and local validation

The hosted-CI repair was copied with source hashes recorded in the execution
handoff. Fresh independent Astra reviewer `/root/billing_ci_delta_review`
approved the exact four-file delta, finding no blocking issue. The unit checkout
alone now gets full history; the harness still runs all PostgreSQL scenarios
and TLS checks. Its import-safe smoke and diff check exited 0.

Sol's final focused matrix passed 45 tests across five CI/billing files; the
policy/routing matrix passed 16 tests. Scoped lint, shell syntax, strict policy
contract and diff checks exited 0. No application source changed in this last
phase. Root reviewed the complete final handoff before landing.

A final production metadata-only comparison found all six newly applied source
names present. The generic all-history comparison still reports 21 older
canonical names absent alongside historical combined/repaired migration names;
this is unresolved name equivalence, not proof those schemas are absent. No
extra migration or history repair was performed or authorized.
