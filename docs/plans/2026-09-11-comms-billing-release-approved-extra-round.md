# User-approved additional correction round

Akhil explicitly reviewed the local feature and approved one additional round
to resolve test failures and continue toward production. This supersedes the
automatic two-correction limit for this round only, not any release safety gate.

## Checkout and evidence

Work only in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`, keeper
`akhil/backlog-repeat-issues`, HEAD
`97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`, existing no-commit merge of
`8ce3868b4e5775661956c6c3f36fcb146bfa931a`. Preserve all existing changes.
Read repository/Akhil/feature-cycle instructions and prior correction2
handoff/review plus root evidence. No writes in original dirty checkout.

Full unit last run: exit1,1391files,9760passed/7failed,713.86seconds.
Unchanged isolated four-file run: exit1,61passed/1failed,11.65seconds.
Only repeatable failure: tests/unit/ci-test-workflow.test.ts:138 requires
ubuntu-latest for unit, but reviewed workflow intentionally pins ubuntu-24.04
to provision PostgreSQL16. Other failures:20second timeouts in manager-phone
scope, inbound email and sandbox-port tests, plus a later inbound-email mock
call count. All six passed unchanged in isolation; cause not yet proven.

## Execution and ownership

Fresh Sol-medium manages Terra implementation and Luna independent narrow
review/test-inventory. Only Terra/Sol may edit
`tests/unit/ci-test-workflow.test.ts`; preserve exact per-job runner contracts
(unit ubuntu-24.04, integration/lint/build ubuntu-latest) and independent
trigger checks. Add a small parsed-YAML regression protecting mandatory
PostgreSQL16/OpenSSL provisioning and executable PATH export before the unit
command if useful, without fragile broad substring-only acceptance. Never
weaken aggregate dependencies, introduce skips/retries or increase timeouts to
mask failures. Workflow itself stays unchanged unless a demonstrated blocker
is returned to root. No runtime/UI/SQL/runner/waiver changes in this scope.

Luna independently checks the CI contract and inspects the previously flaky
tests for mock lifecycle or obvious non-hermetic causes, read-only. Do not
expand into unrelated product fixes. Sol integrates review findings within
this same approved round, and reports any material new scope to root.

## Validation

Use Node22.23.0 and explicit workdir. Serialize all heavy checks on this8GB
host. Run the affected four files at maxWorkers1, scoped ESLint, diff check,
then full `vitest run tests/unit --maxWorkers=1 --reporter=dot` with2GB heap.
Record final results durably including exact exits, counts and any failures.
Root will not run competing heavy checks. Preserve failed-run evidence; a
green rerun is not proof intermittent failures are fixed. Run required
`npx graphify hook-rebuild`; if unavailable report, do not install a different
graph engine or start an unrelated graph rebuild.

No credentials, provider/DB calls, account changes, Git mutations, production
waiver approval, deploys, no-mistakes, Linear, Lavish, or extra correction
round. The consumed recovery operation is immutable and must never rerun.
Fixed billing runner SHA remains
56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6;
named waiver2026-09-11-production-comms-billing remains DRAFT.

Save `docs/plans/2026-09-11-comms-billing-release-approved-extra-round-handoff.md`
with changed files, review decisions and real final test evidence. Root then
launches fresh Astra review for this round. Prior build/typecheck/lint and
14case browser proof still apply if runtime/UI remain unchanged; Akhil has
now reviewed the local feature. Staging, full-E2E disposition, designated
handset checks, exact production migration approval and final web/TestFlight
verification remain mandatory after this correction.
