# Communication billing release correction 2 handoff

Date: 2026-09-11

Status: **FINAL AUTOMATED CORRECTION INTEGRATED; FRESH ASTRA REVIEW AND EXTERNAL RELEASE GATES REMAIN**

Plan: `docs/plans/2026-09-11-comms-billing-release-correction-2.md`, under the original communication billing release plan and prior reviews. This handoff grants no Git, database, provider, deployment, waiver, or production authority. The named production waiver remains DRAFT.

## Checkout and scope

- Workdir for every command: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
- Keeper: `akhil/backlog-repeat-issues`.
- Starting and current HEAD: `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`.
- The existing no-commit merge of `8ce3868b4e5775661956c6c3f36fcb146bfa931a` remains pending.
- This was the second and final automatic correction cycle. Fresh Astra must report any remaining finding to Akhil instead of opening a third automatic cycle.
- No runtime or product source was changed in this cycle. No Git mutation, credential acquisition, remote SQL, provider call, deployment, waiver approval, no-mistakes, Linear, or Lavish action occurred.
- The fixed apply runner, preparation runner, six migration sources, canonical correction, consumed recovery artifacts, CA, and actual waiver content were not edited.

## Integrated changes

### Real PostgreSQL transport harness

- `scripts/testing/comms-billing-migration-apply-local-harness.mjs`
  - Counts attempted and successfully completed bundle-interior execution separately.
  - Timeout and backend-disconnect injection now occurs at the real auxiliary-ledger insertion boundary, after the complete fixed bundle interior executes and before COMMIT.
  - Both cases assert one completed interior, one injection, zero COMMIT, no replay, and fresh independent clean catalog and ledger readback.
  - Existing auxiliary and catalog rollback, confirmed COMMIT/readback, real catalog-negative mutations, lost-COMMIT-response uncertainty/no-replay, and TLS trust/hostname rejection remain exercised.
  - Fails fast with a sanitized, actionable diagnostic when `initdb`, `pg_ctl`, or `openssl` is missing or unusable.
  - Pins the PostgreSQL Unix socket directory to the private disposable fixture directory with `-k`, while retaining loopback TCP, so an ordinary Ubuntu CI user does not depend on a system socket directory.
- `tests/unit/comms-billing-migration-apply-local-harness.test.ts`
  - Keeps the real harness mandatory and adds the missing-tools fail-fast regression.
- `tests/unit/comms-billing-migration-apply-subprocess.test.ts`
  - Source and bundle drift copies now assert the intended sanitized refusal text, exit 1, and no fake CLI invocation.
  - DRAFT/consumed/acknowledgement, copied APPROVED fake-CLI boundary, cleanup, environment isolation, CA refusal, and credential-output sanitization remain covered.

### Seeded composer browser regression

- `tests/e2e/communication-reply-composer.spec.ts`
  - Preserves assistant-thread banner and normal-click layout coverage at widths 375, 768, and 1280.
  - Explicitly confirms assistant scheduling is absent by design.
  - Opens the deterministic seeded Test Resident ordinary conversation and uses its actual `resident-direct-chat-compose` textarea plus form-scoped accessible controls.
  - At all three widths it proves normal focus and typing, emoji selection, file-chooser reachability without choosing a file, Send enablement without submission, schedule check/date/uncheck, and cleared draft state.
  - No message send, upload, scheduled submission, or provider action occurs.

### Mandatory unit CI provisioning

- `.github/workflows/test.yml`
  - Pins the existing mandatory `unit` job to Ubuntu 24.04.
  - Installs PostgreSQL 16 server/client tools and OpenSSL explicitly.
  - Adds `/usr/lib/postgresql/16/bin` to `GITHUB_PATH` and prints harmless `initdb`, `pg_ctl`, and OpenSSL versions before the unconditional unit command.
  - Leaves the `unit` job in aggregate `check.needs` and adds no skip or aggregate bypass.

## Local prerequisites

The unit suite now intentionally includes a localhost disposable PostgreSQL server harness. No external database or secret is required.

- Node: exactly `v22.23.0` for recorded validation.
- PostgreSQL server tools: `initdb` and `pg_ctl` on PATH. CI installs PostgreSQL 16 and exports `/usr/lib/postgresql/16/bin`.
- OpenSSL: `openssl` on PATH.
- macOS example with Homebrew PostgreSQL: install a server package and OpenSSL, then prepend the matching Homebrew bin directory, such as `/opt/homebrew/opt/postgresql@16/bin`, to PATH. This checkout currently resolves working Homebrew PostgreSQL 17.11 and OpenSSL 3.6.3 locally; CI is deliberately fixed to PostgreSQL 16.
- The harness creates and removes only its own private `/tmp/proplane-comms-apply-*` directories, uses a free loopback port and private socket directory, and runs as the invoking ordinary user.

## Final validation

All Vitest commands below used `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node`, `NODE_OPTIONS=--max-old-space-size=4096`, an explicit local PostgreSQL/OpenSSL PATH, and `--maxWorkers=1`.

1. Final integrated narrow unit matrix:
   - `node node_modules/vitest/vitest.mjs run tests/unit/comms-billing-migration-apply.test.ts tests/unit/comms-billing-migration-apply-local-harness.test.ts tests/unit/comms-billing-migration-apply-subprocess.test.ts --maxWorkers=1 --reporter=verbose`
   - Exit 0: 3 files, 24 tests passed, duration 43.30 seconds.
   - Includes the final private-socket real PostgreSQL harness, both post-interior failure modes, TLS cases, subprocess boundaries, fail-fast prerequisite test, and fixed-runner unit boundaries.
2. `node --check scripts/testing/comms-billing-migration-apply-local-harness.mjs`
   - Exit 0.
3. Scoped ESLint over the harness, its wrapper/subprocess tests, and composer browser spec
   - Exit 0, no output.
4. Ruby YAML parse of `.github/workflows/test.yml`
   - Exit 0 with `workflow_yaml_ok`.
5. `git diff --check`
   - Exit 0, no output.
6. Node 22 Playwright collection for `tests/e2e/communication-reply-composer.spec.ts`
   - Exit 0: setup plus two corrected Chromium cases, 5 tests across 2 files.
7. Root-attributed final real browser execution against the already-built production-mode server on dev/test port 3008
   - A Node 22.23.0 inline ES module imported `spawnSync` and canonical `QA_ACCOUNTS`, set a private `0o077` umask, and invoked `process.execPath` with `node_modules/.bin/playwright test tests/e2e/communication-reply-composer.spec.ts tests/e2e/ladder-smoke.spec.ts tests/e2e/public-home.spec.ts tests/e2e/public-tours.spec.ts --global-timeout=720000`. Its process-only environment set the port-3008 app/base URLs, `PLAYWRIGHT_SKIP_WEBSERVER=1`, `E2E_TESTS_ENABLED=1`, a 2 GB Node heap, and the canonical admin/manager/resident QA fields without printing or persisting their values.
   - Exit 0: 14 passed in 1.9 minutes, comprising the exact corrected composer spec plus the existing public smoke and role setup.
   - Both composer cases passed at 375, 768, and 1280. The Test Resident path exercised typing, emoji selection, file chooser with no chosen file, enabled Send without submission, schedule date/uncheck, and draft cleanup. Assistant scheduling was absent.
   - Canonical QA account credentials were supplied as process-only overrides because `.env.test` held a stale legacy admin address. No credential values were printed and no fixture/source file was changed.
   - Default list reporter; ignored `test-results/`; no failure traces were produced. The three generated auth-state files were verified mode 0600.
8. Root-attributed broad stable checks, completed before this test/CI-only correction:
   - Normal production-mode Turbopack build: exit 0, including TypeScript and 387 static pages.
   - Standalone `tsc --noEmit`: exit 0.
   - Full repository lint: exit 0, 0 errors and 719 warnings.
   - Root owns the final full-unit rerun after this handoff; the prior full-unit pass predates this final test-only correction and is not presented as post-correction evidence.

Earlier non-final diagnostics are not passes: Node 23.7.0 Playwright collection failed before collection because of tool compatibility; the same collection passed under required Node 22.23.0. An optional Prettier binary was absent. One concurrent wrapper run exceeded its timeout while another harness process was active; the required serialized final integrated run passed in 43.30 seconds. Root's first public-smoke invocation failed in global setup on the stale legacy `.env.test` admin identity; the process-only canonical QA override produced the final 14-test pass.

## Protected identities

- Fixed runner: `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`.
- Still-DRAFT waiver document: `9b8f208c2e994c5a484c12f87879b6426348cdb9f34e64d0139279f3c4a78e10`.
- Preparation runner: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`.
- Exact atomic bundle: 67,040 bytes, `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.
- Canonical correction: `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`.
- Pinned CA: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- Final local harness: `53177386606421bdcf19fdfa4ef811b50d7735eb3f7b67349383d1908d2d7137`.
- Harness wrapper: `43511b2df87faa9cf2af85028ae0116ef237942e75a4a8ff37ae51857cf5f09c`.
- Subprocess test: `8406e073f890146aca0ff8f8c6f0d6d8ccb1a6867cb0d1e2859aa2fa423b9c08`.
- Composer browser spec: `71b4643a1bdd81ff5a7b5aca6ed19cb667249eb38ad2b7124720116fb3fd831b`.
- Unit workflow: `987b17e946da7ca0468ba297e6aa6547c2d1332533c1de6c78c2c38f70ef54f3`.

The actual waiver status remains exactly `DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED`, and it still records the fixed runner digest above.

## Remaining gates

- Fresh Astra correction-2 review is mandatory. This is the final automatic correction cycle, so any remaining finding is reported to Akhil without another automatic Sol cycle.
- Root owns the post-correction full unit run and any final stable broad-gate consolidation. Hosted GitHub CI has not been observed for this workflow change; the YAML and local dependencies were validated, but the Ubuntu 24.04 package provisioning must still pass in actual CI.
- The Review URL is `http://localhost:3008/portal/communication/active` on the local dev/test-backed production-mode server. It is not staging or production.
- Existing full-E2E nightly failures require explicit disposition. The narrow corrected browser path and public smoke are green but do not replace the full suite.
- Exact-SHA staging deployment with staging-scoped credentials, reviewed one-shot staging apply/readback, full billing/tour/recovery QA, designated test-handset receipt/STOP/START/reply acceptance, and invoicer cutover/rollback proof remain outstanding.
- Then remain ship preflight, fresh bounded production preflight, Akhil's explicit approval of named waiver `2026-09-11-production-comms-billing` for runner `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`, one-shot production apply with independent readback, staging-to-production promotion, and Vercel/TestFlight distribution verification.
- An uncertain apply is never retried. No staging or production database write or deployment occurred in this cycle.

## Exact fresh-review prompt

> Fresh Astra review for correction cycle 2, the final automatic communication-billing release correction. Work only in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`, with that explicit workdir for every command. Read the full Akhil feature-cycle skill, `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, `docs/agents/akhil-feature-cycle.md`, the original release plan/review/handoff/root evidence, correction-1 plan/review/handoff, correction-2 plan, and `docs/plans/2026-09-11-comms-billing-release-correction-2-handoff.md`. HEAD remains `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2` with the pending no-commit merge. Review only `.github/workflows/test.yml`, `scripts/testing/comms-billing-migration-apply-local-harness.mjs`, `tests/unit/comms-billing-migration-apply-local-harness.test.ts`, `tests/unit/comms-billing-migration-apply-subprocess.test.ts`, and `tests/e2e/communication-reply-composer.spec.ts`, plus protected-identity readbacks. Verify the post-interior timeout/disconnect boundary and no replay, private socket portability, fail-fast tools, sanitized drift diagnostics, Ubuntu 24.04 PostgreSQL 16 unit provisioning, deterministic assistant/Test Resident browser coverage, exact hashes, and truthful evidence attribution. No source redesign, Git, credentials, remote SQL/provider/deployment, actual waiver approval, no-mistakes, Linear, or Lavish. This is the final automatic correction cycle: if findings remain, report them precisely to Akhil and do not write a third correction plan. If sound, approve only for root's remaining release gates. The actual waiver must remain DRAFT.
