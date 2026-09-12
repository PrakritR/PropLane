# User-approved extra round: root release evidence

Akhil confirmed he reviewed the local feature and explicitly authorized one
additional correction round and continued production release. Local review is
therefore no longer outstanding. This approval does not name or approve the
separate production communication-billing schema waiver, which remains DRAFT.

Root started fresh Sol-medium `/root/approved_extra_round` with the bounded
plan. Its Terra delegate spawn hit the thread cap, so root explicitly authorized
the previously used exact-model local CLI fallback for Terra and Luna. There
is no model substitution and no no-mistakes invocation.

Read-only remote Git check still matches pinned state: keeper97815a2d,
main/staging8ce3868b,production2d1353af. Existing no-commit merge remains intact.
No Graphify graph exists at either .graphify/graph.json or graphify-out/graph.json;
repo docs are the fallback, not an invented semantic graph.

Final56e88313 runner `--preflight-staging`, Node22.23.0, EXIT0:
preflight_passed,6sources,ledger187,other_sessions4,active_sessions0,
long_transactions0,lock_waiters0. No apply command was run.

Current live Vercel deployment independent GET:
dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T,READY,targetproduction,
GitHub repo1213837671/refproduction/SHA2d1353af42c3a652be6cf8a69640468b453f4cea.
Runtime and build environment inventories each have203entries and neither has
COMMS_PAYG_BILLING_ENABLED. Current project env metadata also has no such key.
Candidate invoice helper and cron are unconditional retired/no-op paths after
cron authorization; current live helper exits before DB/provider work when the
flag is absent. Restrict any rollback to this exact verified disabled deployment;
do not assume arbitrary historical deployments are safe. No cron/provider call
was made to establish these facts. Manual credit checkout remains disabled.

GitHub full-E2E run34589386066 at main8ce3868b was independently confirmed:
unit/lint/build/integration/checkSUCCESS; e2e-fullFAIL52failed110passed2notrun.
Failure logs include the now-corrected composer, missing seeded-public surfaces,
session-expired/redirect failures, missing headings and outdated calendar/modal
selectors. These are categories, not a blanket waiver or proof every failure is
unrelated. The existing14case local browser pass is not full-E2E evidence.

Staging Git integration backup workflow still depends on a missing
VERCEL_TOKEN; a successful git-integration notice is not a deployment. Existing
project and staging-branch environment scoping must be preserved. The protected
branch Git workflow remains the first deploy path. No project relink, token
copy, new project, settings change, API deployment or local upload has occurred.

An async request asks Akhil to designate a QA account/handset for receipt,
reply,STOP/START tests. No customer phone or incident number is approved for
active testing by inference. Production account/message writes would need a
separate named scope; ordinary staging testing uses only designated QA data.

Staging authentication prerequisite check used only canonical manager/resident
QA credentials from QA_ACCOUNTS with persistSession:false/autoRefreshToken:false
against asserted xwszcafaontidfgznlxd. Both returned invalid_credentials; no
password reset, signup, saved token or account mutation was performed. Dev/test
login success is not staging login evidence.

Additional read-only CI comparison uses complete final failure-summary titles
(not annotations, which omit some cases), normalized only for line numbers.
Current run34589386066:52failures. Previous run34466021119 at0b6d5679:
52failures,110passed,2notrun. Prior run34341285957 at26404c43:
50failures,110passed,2notrun. Of current52,47 recur from yesterday and51 recur
in either previous run. The sole title absent from those two prior summaries
is mobile-portal-layout.spec.ts, resident bottom nav renders every tab within
the viewport. This is historical recurrence evidence only; exact errors and
current behavior still need disposition. It is not a green current full suite.

Extra round narrow four-file matrix passed63tests. Root caught missing optional
WorkflowStep.name typing in the initial test addition and asked Sol to integrate
that field plus unconditional provisioning-step assertion within this same
approved round. Sol reports stable updated narrow EXIT0/63tests/8.13s and scoped
lint/diff EXIT0. An attempted2GB standalone typecheck hit heap OOM/EXIT134, not
a pass; Sol owns serialized full unit then4GB typecheck. No runtime/workflow/
migration/waiver source changed in this round. Final CI test hash at this entry:
dea7438e89010216f802e66b08043220bd83c1ba0871b3e8c9f42fe775d7247b.

Under Akhil's standing request to create/reuse a QA account and save its details,
root created one isolated STAGING-only manager after a no-existing-profile
precheck:release.qa.20260911@test.proplane.local,
user4607b4c2-8a1f-4840-a0db-11b4472b62e7,managerrefmgr_release_4607b4c2.
Only new auth account, its profile and manager role were written. No old account
was reset; no phone, consent, payment method or subscription was created and no
provider API was called. Password uses the canonical QA fixture source; no
credential value was printed. Subsequent staging signInWithPassword succeeded.
This is auth prerequisite evidence, not browser QA. Private login reference:
/Users/akhilvemuri/.local/share/proplane-codex/staging/README.md(mode600),
containing directory700. This account has no customer records.

Root verified cwd and ownership before stopping only its own local Next server
PID53186/parent53148 on3008 to free memory for unit/typecheck. The compiled
artifact remains intact and will be restarted before browser QA. No unrelated
user process was stopped.

Final extra-round Sol handoff reports stable full unit EXIT0:1391files,
9768tests,533.20seconds with Node22.23.0/2GB/maxWorkers1. Serialized standalone
4GB TypeScript completed EXIT0. The earlier2GB OOM remains a failed resource
attempt, not a source failure or a hidden pass. Scoped lint and diff EXIT0.
Fresh Astra reviewer approved_extra_round_review was launched with an isolated
context and the bounded plan/handoff; review is pending at this entry.

Root restarted the unchanged compiled dev/test Next server on pinned3008,
asserting emstjswhotsnyksqhqyf before startup. No production env file was used.
Resident mobile bottom-nav test with fresh canonical role setup and zero retries
passed EXIT0:4cases,19.9seconds (3auth setups plus resident navigation). This
closes the only newly appearing nightly failure title as a local isolated pass,
not a proof that the old full-suite auth/load failure cannot recur. Root started
the complete local browser suite with the same dev/test server and canonical
process-only credentials, one worker, zero retries, default45minute limit.

ship:preflight EXIT0 reports11ok/4warnings, not full production readiness:
dirty worktree, shell production env absent, ledger parity unchecked by that
generic command, and Langfuse env absent. Bounded migration/catalog and Vercel
metadata checks remain separate gates; no secret env was pulled to bypass them.
sandbox:open EXIT0 returned http://localhost:3008/portal/communication/active.

Fresh Astra extra-round review approved with no blocking finding in its bounded
scope; independent CI contract run10tests/264ms/EXIT0. Root read the complete
review and prior release security/bugbot adjudications. STOP High is closed by
recipientUserId forwarding plus zero-provider/budget/wallet regression; manager
guard Medium is closed by canonical actor authorization and route tests.
Subscription idempotency was independently adjudicated a pre-existing Medium
follow-up, not an unresolved High. Conservative campaign allocation was not
accepted as a defect under the protective-cap contract. Runner verification
findings were closed by the two prior fresh Astra reviews and real-PG tests.
No unresolved Critical/High remains in these retained release reviews.

Root is landing only the reviewed keeper integration and its owned release
artifacts; pre-existing unrelated untracked notes remain outside the commit.
Full local E2E is running177cases; no pass is claimed before its final result.
Main/staging deployment does not authorize production or waive staging QA.
