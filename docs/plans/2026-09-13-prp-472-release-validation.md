# PRP470/472 user-authorized release validation

Akhil requested one more test and progress to production. This continues the prior stopped correction cycle with explicit new authorization. The release ladder remains keeper -> main -> staging QA -> production. No no-mistakes or PR is requested.

Current candidate base is remote main/staging/production `75d711053085e340072c605bcb96eaa9416ef87e`. Keeper `akhil/prp-472-inbox-unread` includes PRP470 plus the PRP472 follow-up and merged current main without conflicts. The accepted product source is committed at `542d11ca0`; final release QA additions are described below.

## Isolated staging fixture and prerequisite privacy smoke

Created unique manager/resident/vendor QA auth accounts with random passwords, confirmed without provider email, and only their own profiles/role rows, one inbox record and one linked vendor directory record. Private credentials and IDs are retained only in `/private/tmp/axis-inbox-release/staging-qa-state.json` (0600). Fixture prefix `prp472-release-1789352747840`. Existing users, passwords, listings and provider settings were unchanged. Target hostname was asserted as `xwszcafaontidfgznlxd.supabase.co`.

Actual commands, Node 22, exit 0:

- `node /private/tmp/axis-inbox-release/staging-qa.mjs seed`: isolated three-role fixture.
- `node /private/tmp/axis-inbox-release/staging-vendor-direct.mjs`: anonymous and signed-in isolated vendor direct known-row PostgREST queries both returned empty arrays. No manager-private directory fields exposed.
- `node /private/tmp/axis-inbox-release/staging-vendor-route.mjs`: authenticated GET `https://staging-prop-lane.space/api/vendor/documents` returned 200, linked=true and the fixture's insurance-provider sentinel, with no private-note sentinel or notes property. This confirms the service-backed reader still works with direct directory reads closed.

This is a baseline staging prerequisite smoke, not final candidate deployment proof. Repeat after promotion. No production schema or data writes have occurred. The four older production migration gaps and new controls recovery trigger repair remain separate, reviewed release scope; see the inventory and prerequisite review.

## Actual staging recovery rehearsal

Fresh security reviewer assessed the bounded wrapper before execution. The private `staging-recovery-rehearsal.sql` strips only the source migration's outer BEGIN/COMMIT and probe's psql meta-command, then executes the byte-identical migration DO body twice inside the probe's first transaction after its 5-second lock/15-second statement limits. Both existing ROLLBACKs and all assertions remain. No migration ledger writes or permanent DDL occur.

`supabase@2.117.0 db query --linked --project-ref xwszcafaontidfgznlxd --file /private/tmp/axis-inbox-release/staging-recovery-rehearsal.sql --output json`: exit 0. Actual deployed recovery functions passed exact trigger catalog/idempotence, held-write denial, exact one captured delete hold, and retained-state finalization assertions. Final result reports zero auth, profile, role, controls, request, record and hold fixture rows. Separate post-rehearsal lifecycle query exit 0 and exact pre/post JSON comparison passed, including absent custom controls triggers. The rehearsal rolled back all schema and fixture changes.

Read-only aggregate uncaptured controls hold queries on both staging and production returned empty rows, exit 0. No existing stuck controls holds were found; no historical data repair was performed.

## Staging prerequisite catalog comparison

Read-only staging prerequisite inventory exit 0. All eight affected function bodies exactly match the three source migrations after extracting their dollar-quoted bodies. Seven callable mutation/revision functions retain postgres/service_role-only EXECUTE ACLs; the stamping trigger retains its existing trigger-function ACL. The phone column and automation cutoff exist, email is nullable, controls table exists, and the removed vendor direct-read policy is absent. Full definitions and comparison output remain private under `/private/tmp/axis-inbox-release/staging-prerequisites.json` and `staging-function-body-comparison.json`.

## Final corrected source and validation

Source committed locally as `542d11ca0` after the final R1/R2 corrections. The 33-file release source/script/test/SQL freeze aggregate is `7432b0cc36d65cd4822aa16295e368812194258ad4b4d7fe35b64f11df263ce8`. Final source includes explicit authorization-refusal Retry recovery and empty-tgattr exact recovery-trigger validation.

Final full unit command `npm run test:unit -- --reporter=dot`, Node22, exit **0**: **1,465 files / 10,349 tests passed**, 217.73 seconds wall time (Vitest216.33s). Log `/private/tmp/axis-inbox-release/unit.log`. The earlier single-worker run passed10,345 tests but overlapped correction work and is retained only as historical evidence, not final freeze certification.

Corrected actual staging recovery rehearsal also exited **0**. Source migration SHA `0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4`; private rollback wrapper SHA `bbbcf475863f7dbbc7395750f4c7211d712edfd1e0946704d94f4d4eb950414e`. Both installations and all lifecycle/catalog/leak assertions remain. All seven final fixture counts are zero; independent post-query exit0 and full pre/post lifecycle catalog equality passed again. This supersedes the earlier rehearsal for final SQL bytes.

Full repository lint `npm run lint`, Node22 with6GB heap, exit **0**, 91.34s: **0 errors**,746 existing warnings. Build is running with the DEV hostname independently asserted and no production env files present.

Production-mode build `npm run build`, Node22 with6GB heap, exit **0**,60.34s, including TypeScript and all route generation. DEV hostname was asserted before build. All33 frozen source hashes independently verified unchanged after unit/lint/build.

Root real DEV browser `dev-retry-browser.mjs`, exit **0**: same-viewer401 and403 initial refusals, another explicit refusal, then explicit Retry succeeds through the real endpoint and reveals the actual list. Refocus alone issues no retry; phone layout fits. Fresh contexts were used per status. Root viewed the390px screenshot. No provider sends. `npm run sandbox:open` exit0 for the canonical mixed conversation Review URL.

Targeted retained portal E2E setup initially inherited obsolete `@test.axis.local` accounts from ignored .env.test; the private runner now explicitly uses repository canonical `@test.proplane.local` fixture credentials, without changing any account/password. First actual run10/12passed: missing named email fixture and resident redirect/evaluation timing. The resident measurement-only retry was reviewed independently and passed in the next run11/12; actual overflow assertions remain outside the retry. Scoped lint and TypeScript after that mechanical test fix exited0. The remaining legacy composer test assumes older schedule/emoji/fixture behavior and is being aligned with the existing mixed conversation UI. An isolated pure-email QA row used to diagnose the mismatch was removed after exact ownership/body/subject/email verification; no other fixture was overwritten. Graphify hook refresh remains exit1 because npm cannot resolve its executable.

## Final browser-discovered width correction and CI fixture maintenance

The maintained composer spec reached the actual direct-pane controls and measured129px at375px, failing its preserved >140px assertion. SMS UI off would still render the channel selector. A fresh Sol/Terra/Luna cycle corrected only phone spacing in the shared composer: outer gaps6->4px and inner three-tool gaps4->0px below640px. The640-767px and md+ gaps, control sizes and behavior are preserved. Final source SHA `3f6304856dfd80e00f51598b5c27960182ef4a58d88e6c3e153e21f39f68f356`; see the width plan/handoff. Source was refined during the unit run before the final build; the real browser is the geometry gate, and no unit expectations changed.

Existing baseline GitHub Test runs34784073390 and34784422435 failed only two vendor integration cases; their hermetic check and smoke jobs passed. Root reproduced the same2failures locally (273passed,40skipped). The fixtures lacked accepted-link query responses and still mocked an upsert although the actual route uses ownership-safe insert/select/maybeSingle. Root updated only those mocks, preserved the403other-owner and200own-vendor assertions, and additionally asserts the authenticated stored owner. No vendor route/auth behavior changed. Full `npm run test:integration` now exits **0**:51files passed,5skipped;275tests passed,40skipped;16.84seconds. Log `/private/tmp/axis-inbox-release/integration-final.log`.

The final37-file source/test/script/SQL inventory is `2f24e6e624a6e289d735fc4aff3f148a9d6eac3d22a9448d74693a5a1ee527e4`; original33 accepted hashes remain unchanged. The four additions are the shared composer, two E2E specs and vendor integration fixture. Graphify refresh was attempted again after these changes and exits1 with the same unavailable executable; no graph artifact was changed.

Repeated full unit validation exits **0**,1,465files/10,349tests,206.96seconds. Final production-mode DEV build exits **0**,39.48seconds, including TypeScript. The four-file delta's scoped lint exits **0**,0errors/12existing shared-component warnings; the earlier full repository lint remains0errors/746warnings. `ship:preflight` and final `sandbox:open` exit **0**.

Actual geometry browser exits **0** on final product bytes:375px textarea143px with4px outer/0px inner gaps;640px textarea366px with6/4px gaps;768px textarea391.66px and1280px textarea331.11px, both8/6px gaps. No horizontal overflow at any width. Root inspected the375px and1280px screenshots and confirmed usable controls and native-bottom-nav clearance.

Final rebuilt-product broad portal E2E yielded11/12passed, with the sole remaining failure caused by rapidly reopening the desktop schedule dropdown while its prior menu was animating out. The spec now waits for that menu to unmount before reopening and after cancellation. This adds a state-based wait, not a test retry or changed acceptance assertion. The focused final composer rerun exits **0**,4/4passed (three role auth setups plus resident composer exercising375/768/1280),27.503seconds. Thus all12 distinct cases have passing coverage across the broad and focused runs; this is not a claim of a single12/12run. No product changes followed the final build. Provider sends and uploads were not performed.
