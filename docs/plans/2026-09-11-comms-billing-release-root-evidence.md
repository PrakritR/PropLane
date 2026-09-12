# Release coordination evidence - September 11, 2026

Root Astra evidence for `2026-09-11-comms-billing-release-plan.md`.
Worktree: treehouse slot 3, keeper `akhil/backlog-repeat-issues`, HEAD
`97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`, pending no-commit merge of
`8ce3868b4e5775661956c6c3f36fcb146bfa931a`. No release commit or production
deployment has occurred in this phase.

## External read-only checks

- Fresh Git refs: main and staging `8ce3868b4e5775661956c6c3f36fcb146bfa931a`;
  production `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- Vercel project `proplane`, `prj_rupckw3T2v0oXVg2nTLVCYePKDUc`, Git link
  PrakritR/PropLane, production branch `production`. No settings changed.
- Latest inspected READY production deployment `dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T`
  matches live `2d1353af`. Latest listed READY staging deployment
  `dpl_DHFznkJpSYESz7pKeXzVrvtoDgUs` remains on `0b6d56794407277761ad5f6c680a522e97db2e6d`,
  not current staging Git. Production env/build inventories omitted
  `COMMS_PAYG_BILLING_ENABLED`. No invoicing cron was invoked.
- GitHub Vercel workflow `34552913754` did not deploy: configured=false,
  deploy skipped, Git integration notice succeeded. VERCEL_TOKEN is missing.
  No Vercel commit status was present on main/staging SHA8ce. Do not call the
  green notice job a deployment or silently use generic Preview credentials.
- Fresh metadata-only database checks: production ledger176, staging187;
  five billing migrations/new credit tables absent; compatible manual_payments;
  zero eligible backfill; no active client transactions/long transactions/lock
  waiters in the initial check. Reads used TLS and read-only transactions.
- New fixed runner staging preflight at approximately 17:21 UTC:
  `node scripts/apply-20260911-comms-billing-migrations.mjs --preflight-staging`
  exited0, preflight_passed, six sources, ledger187, four other sessions,
  zero active sessions/long transactions/lock waiters. This is read-only, not
  approval or an apply. Runner candidate at the time was
  `bd4f1f687c02329164e25cc439e0f62a0d699a6bf49f8692c94b076d944b57d7`.
- Historical incident readback: Langfuse trace
  `de38a267-97b4-4c4d-b5b1-4636e807e6d2` returned HTTP200 with six observations.
  Twilio message `SM65b91838c959f7af61bdd584262cbd70` returned HTTP200,
  delivered, error_code=null. Bodies, phone numbers, tokens and raw trace
  inputs/outputs were not printed. This confirms the existing ordinary reply
  receipt, not new lifecycle notification acceptance. No provider sends occurred.

## Browser and CI

Latest full nightly `34589386066`, e2e-full job103230915115, failed52 cases,
passed110, two not run. Unit, lint, build, integration and aggregate check
passed. Historical ship-gate wording about18 known failures does not explain
the current52. Symptoms include stale headings/locators, session expiry,
production-runtime sandbox fixture hiding, and the composer interception below.
These are diagnostic categories, not a complete root-cause adjudication.

Used Playwright CLI with existing Chromium1228 because system Google Chrome
was not installed. Existing localhost3008 dev server, seeded dev/test manager.
Private saved session had expired, so signed in using the canonical fixture
without printing its password and explicitly selected Property portal.

Communication active -> PropLane Assistant thread, temporary54px DOM-only
status banner, no send or durable message edit. At375x844 the reply textarea
was x254.25/y735/width62/height44; its center hit the emoji SVG. Normal click
timed out after5000ms. At768x844 and1280x844 normal clicks succeeded. Screenshot:
`output/playwright/20260911-composer-375.png`. Shared portal-inbox-ui,
portal-message-compose-fields and globals.css have no diff from live, so this
is a reproduced pre-existing affected-surface failure, not evidence of a new
merge regression. It remains unresolved QA, not a pass.

## Independent reviews and disposition pending

The stable pre-correction full unit run completed exit0:1389files,9754tests,
duration327.41seconds, as polled by Sol in its agent-scoped session64008. Root
could not directly poll that ID (Unknown process), so Sol retained monitoring
ownership and delivered the exact result. Earlier resource-contended/across-edit
unit and tsc attempts were interrupted exit130, not counted as passes.

Fresh Astra review completed in a separate exact-model session and independently
passed21 focused tests, verified hashes, and closed the dispatcher STOP High.
It requires correction1 before staging apply: real pg/TLS/waiver/subprocess
failure coverage, stronger structural catalog verification, canonical manager
authorization on subscription checkout, and the reproduced phone composer.
Subscription idempotency was downgraded to Medium pre-existing follow-up;
conservative campaign cap reservation was not accepted as a defect under the
documented contract. See the dated release-review and correction-1 plan.
Fresh Sol-medium correction session began around17:31UTC, using the planned
Terra/Luna split. No production or staging apply occurred.

Exact-model CLI delegates were used after collaboration spawn returned thread
limit. Terra wrote the security-review report and Luna wrote the bugbot report
under docs/security, excluding the actively changing runner/test. They made no
source, Git or external mutations.

Root independently confirmed the missing recipientUserId in final dispatcher
policy. Sol added it and a user-keyed STOP regression before provider/budget/
wallet work. Fresh Astra must verify the final correction and review runner.
The reports' remaining subscription checkout and campaign-cap findings need
independent severity/contract adjudication. Subscription session non-idempotency
also exists in live; its duplicate-payment scenario requires completing two
separate checkouts. This does not itself close the finding. Campaign allowance
is reserved once per outbox/day before provider work; do not reorder/refund it
without preserving uncertain-outcome and retry safety. No broad correction has
been implemented by root.

## Remaining release gates

Root `npm run ship:preflight` under Node22 exited0 at about17:28UTC, 11 checks
and four warnings. Shell credentials were absent: production variable values
and migration parity were NOT checked, Langfuse regression was not run, and the
pending merge was dirty. This is not a production readiness pass. Metadata also
retains historical duplicate names: production agent_pending_actions; staging
agent_pending_actions and resident_invite_links. History reconciliation remains
separate from the fixed six-source waiver; do not repair it opportunistically.
Root stopped only its owned treehouse Next dev process90345 and the release QA
browser to reduce resource contention. The refreshed manager browser state is
saved privately with mode0600 for continuation.

Integrated verification/handoff, fresh Astra and affected security re-review,
current seeded feature/browser QA including failed phone-width composer,
reviewed keeper landing and actual exact-SHA staging deployment, staging schema
apply/readback and full feature QA, designated test handset permission and
receipt/STOP/START/reply acceptance, cutover/rollback proof, ship preflight,
fresh production preflight and explicit final named-waiver/runner-hash approval,
one-shot production apply, staging-to-production promotion, Vercel and TestFlight
distribution verification. No staging or production database writes have occurred
in this phase. The production billing waiver remains DRAFT.

## Root correction-1 browser check, approximately 17:43 UTC

Restarted only this checkout's dev server on pinned port3008 after verifying
the effective env targets dev/test and no .env.production files exist. Restored
the private seeded-manager browser state. The assistant thread and temporary
54px DOM-only banner reproduce the original layout conditions.

Normal center click, focus, typing, emoji menu open/Escape, and enabled Send
all passed at375/768/1280px. Textarea widths were251/417.75/354.64px respectively.
Draft text was cleared at every width. No message sent, attachment uploaded,
or production/provider write. Screenshot inspected visually:
`output/playwright/20260911-composer-corrected-375.png`. The phone navigation
remains below the composer and the Send via control now occupies its own row.

IMPORTANT test-fixture finding: the assistant thread has ZERO
`inbox-thread-schedule-later` controls at every width, so the new browser spec's
unconditional schedule assertion cannot pass on that thread. Scheduling must be
tested on an eligible ordinary conversation, not added to the assistant just
to satisfy the test. Attachment chooser and ordinary-thread scheduling proof
remain pending. These observations do not claim the automated spec passed.

The ordinary seeded Test Resident thread does render Schedule for later. Root
drove its checkbox on/off and saw the date control, without scheduling a send.
Its actual textarea data-attr is `resident-direct-chat-compose`, with matching
`-attach`, `-emoji`, `-send` suffixes. The new spec hardcodes `inbox-reply-*`,
which does not match that ordinary thread. Prefer accessible roles and a
composer-scoped file input, or derive the prefix from the observed textarea.
An initial root attachment check using the same incorrect prefix timed out
(exit1), not an application failure. With the actual prefix, normal clicking
opened the native file chooser. No files were selected/uploaded. Playwright CLI
intercepts file-chooser modal state, so the batched loop did not return complete
per-width results. An attempted no-argument CLI upload/cancel was refused
(exit1); root closed its browser session instead. Do not claim the entire
attachment/schedule automated matrix passed from this partial evidence.

Root integrated TypeScript check under Node22.23.0/4GBheap completed exit0 at
approximately17:51UTC: `tsc --noEmit`. Stopped this checkout's owned Next dev
parent86290 before that compiler. A single production-mode Webpack build then
started with `.env.test` pinned to dev/test, explicit localhost3008 app origin,
`PROPLANE_LOW_MEMORY_BUILD=1`, and no .env.production file. Build result pending.

The first build exited9 before compilation: Next's Webpack worker propagated
Node's `--env-file` flag into NODE_OPTIONS, where Node rejects it. Root restarted
the same build using dotenv-parsed `.env.test` passed through the child process
environment instead of a Node CLI env-file flag, retaining the exact dev/test
host assertion and localhost3008 origin. This is a launcher correction, not an
application code change; only one build is active.

Corrected Webpack launch exited1 with UnhandledSchemeError on node:crypto,
through account-recovery-storage -> supabase/service -> protected-accounts ->
protected-accounts-fetch-shield. These files have NO diff against live
origin/production; instrumentation already returns early outside nodejs runtime.
Root is checking the normal default Turbopack release build before treating
this optional low-memory Webpack path failure as a release regression. No source
change was made to bypass the shield or account-recovery crypto. Default build
uses the same dev/test-pinned environment and4GB heap, one compiler only.

Updated runner `e575dba49a5e4079bd074b63891656198c2cacd301b693b0c35b36e3667f0ea5`
read-only staging preflight passed exit0 again at approximately17:55UTC:
six sources, ledger187, other_sessions4, active_sessions0, long_transactions0,
lock_waiters0. This is neither approval nor apply.

Normal Turbopack compiled successfully in3.2min and entered TypeScript. Full
lint was started alongside it, but host inspection found8GB physical RAM and
17.9GB swap in use. Root verified its ESLint PID26299/cwd and stopped only that
process to serialize heavy validation. Full lint ended143, NOT a pass, and must
be rerun after the build. No unrelated user's process was terminated. Final
normal build result still pending.

Normal production-mode Turbopack build completed exit0, including TypeScript
(10.2min under host swap pressure), all387 static pages, and route optimization.
The normal release build is green; optional low-memory Webpack remains a
separate pre-existing import-chain failure. Root restarted full lint alone
with2GB heap after build completion. Fresh Astra correction1 review is running
in collaboration agent `/root/comms_release_review1` (spawn now available),
with the browser fixture and hermetic CI/test-boundary gaps in scope.

Full repository lint rerun completed exit0:0errors,719warnings. Root started
the completed production-mode build on pinned3008 with explicit dev/test env,
1GB server heap and no dev compiler. `npm run sandbox:open --
/portal/communication/active` exited0 and opened Review URL
`http://localhost:3008/portal/communication/active`. The first open command had
a workdir typo and was rejected before execution; the corrected command above
succeeded. This local Review URL is not staging or production.

Fresh review accepted runtime corrections but wrote the bounded final
correction2 plan for browser fixtures/selectors, explicit CI PostgreSQL tools,
post-interior timeout/disconnect proof, and specific drift diagnostics. Fresh
Sol collaboration agent `/root/comms_release_correction2` is managing it; its
Terra spawn hit the thread limit, so root instructed exact-model CLI fallback
as used successfully in correction1. Root released narrow-test resources only
after build and full lint completed. No third automatic correction cycle.

Root public9browser smoke invocation exited1 in globalSetup before any cases:
`.env.test` supplied legacy `admin@test.axis.local`, which did not finish login
within25seconds. Do not disable E2E to turn this green. Root is correcting only
the invocation environment to current canonical `QA_ACCOUNTS` from
`tests/fixtures/qa-accounts.mjs`, without printing passwords or editing fixture
source, and will rerun after Sol's narrow-test slot. The earlier manual browser
QA used canonical `manager@test.proplane.local`, not the stale env identity.

Read-only deployment fallback research: official Vercel OpenAPI at
`https://openapi.vercel.sh` confirms POST/v13/deployments accepts gitSource
`{type: "github", ref, repoId, sha}` (ref and repoId required, SHA supported).
Official endpoint documentation is
`https://vercel.com/docs/rest-api/deployments/create-a-new-deployment`.
This could trigger an existing-project Git-based staging deployment if the
protected branch push still produces no build, without uploading a local tree
or changing project/branch settings. It has NOT been invoked or approved as a
substitute for gates. Before using any fallback, preserve staging branch-scoped
env, verify exact branch SHA and target project, and verify actual deployment
metadata/bundled DB host. Generic Preview remains unsafe. No new GH/Vercel
secrets, webhook scopes, project settings or deployment were created.

## Final correction-2 browser execution

Root launched Playwright with process-only E2E_ADMIN/MANAGER/RESIDENT credentials
from canonical QA_ACCOUNTS, localhost3008 app/base URL, skip-webserver=1,
E2E_TESTS_ENABLED=1 and private umask077. No credential value was printed.
Exact suite: corrected communication-reply-composer.spec.ts plus ladder-smoke,
public-home and public-tours specs, default setup dependencies and zero retries,
global timeout720000. Result EXIT0:14passed in1.9min (3role setups,2composer
cases,9publicsmoke). Canonical auth preflight and manager/resident/admin portal
setup all passed.

Assistant/banner normal-click case passed at375/768/1280 with scheduling absent.
Ordinary Test Resident case passed all three widths: normal center click/focus,
typing, emoji selection, native file chooser without selecting a file, Send
enablement/hitbox, schedule check/date entry/uncheck, and cleared drafts. The
existing getByRole textbox date locator DID pass in Chromium; root's earlier
portability concern required no test or product change. No provider message,
upload or scheduled submission occurred. This is real non-demo browser proof,
not only collection, and it does not stand in for the entire full E2E suite.

Read-only iOS readiness check: current live SHA2d1353af TestFlight workflow
34539546684 completed success. Both Build+upload and Distribute build to
internal TestFlight group steps succeeded. This is historical pipeline evidence,
not a claim this candidate was shipped or a replacement for post-push checks.

## Final independent review and full-unit gate

Fresh Astra correction-2 review approved its bounded five-file correction scope
and independently matched the immutable runner, preparation, migration, bundle,
CA and waiver hashes. Review artifact:
`2026-09-11-comms-billing-release-correction-2-review.md`. This is correction
approval only, not production or migration approval. The named communication
billing waiver remains DRAFT; no commit, push, remote apply or deploy occurred.

Root's final stable-source full unit invocation started at18:25:29UTC with
Node22.23.0, NODE_OPTIONS=--max-old-space-size=2048, and
`vitest run tests/unit --maxWorkers=2 --reporter=dot`. Session97642 has emitted
failure markers and is still running at this entry. No final pass is claimed.
The exact failing cases must be read from its final summary. Both automatic
correction cycles are consumed; any remaining findings must be reported to
Akhil, not silently routed through a third automatic correction cycle.

Final full unit completed EXIT1,713.86seconds:1391files,1387passed/4failed;
9767tests,9760passed/7failed. Exact failures:

- ci-test-workflow.test.ts:138 still requires ubuntu-latest for every
  non-browser job, conflicting with correction2's intentional unit-job pin to
  ubuntu-24.04. This is a deterministic correction2 contract-test mismatch.
- claw-manager-phone-scoping.test.ts:122 timed out at20seconds.
- inbound-email-webhook.test.ts:491,498,511 each timed out at20seconds;
  line554 observed two limiter calls instead of one in a later case.
- sandbox-port-range.test.ts:64 timed out at20seconds.

Root is rerunning only these four files unchanged with maxWorkers1, same
Node22/2GB heap, to distinguish isolated reproduction from suite/load effects.
This does not erase the failed full run or constitute another correction cycle.
No assertion, timeout, workflow, or runtime source was changed to make it pass.

Unchanged isolated rerun completed EXIT1 in11.65seconds:4files,3passed/1failed;
62tests,61passed/1failed. All six non-CI failures from the full run passed in
isolation. That suggests suite/load sensitivity but does not prove the root
cause or resolve flakiness. The sole repeatable failure is
ci-test-workflow.test.ts:138:expected ubuntu-latest,received ubuntu-24.04.
The unit job intentionally pins Ubuntu24.04 for PostgreSQL16 tool provisioning;
the contract test must preserve exact runner expectations per job and retain
independent-trigger assertions, rather than weaken or skip the gate.

Root stops here under the explicit two-correction-cycle limit and reports the
remaining finding to Akhil. Next work requires direction to run a bounded
follow-up correction, followed by stable full-unit verification, full-E2E
disposition and the existing staging/production gates. A passing isolated
rerun is not a green full suite. Production remains at previously observed
2d1353af42c3a652be6cf8a69640468b453f4cea; no release commit, push, deploy, remote
apply or provider send occurred in this turn. Review server remains available
at http://localhost:3008/portal/communication/active using dev/test only.
