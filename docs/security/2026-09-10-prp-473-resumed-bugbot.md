# PRP-473 resumed Bugbot review

Date: 2026-09-10. Fresh independent correctness review for `docs/ship-gate.md`.

Disposition: no actionable correctness finding established in the reviewed snapshot. The two P2 findings from correction 2 are closed. Acceptable for keeper handoff, subject to the parent review and remaining acceptance gates. This is not approval to promote or a claim of production/handset acceptance.

## Snapshot and scope

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Keeper: `akhil/backlog-repeat-issues`. Base and independently observed HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`. Reviewed the accumulated dirty PRP-473 source/test changes against HEAD, including the untracked resolver and tests. No commit represents this snapshot.

Independently verified SHA-256:

- `src/lib/tour-reschedule-sms-reply.server.ts`: `a75cd1caf2d02bf6a4da3ba61353240fd0f765b63d64bf5e14d9ebcc9a1ecbe5`
- `tests/unit/tour-reschedule-sms-reply.test.ts`: `6d910219dc8ef3007f90f4924c7f80ac7a4e0aa1e7ea633e1cf3246acca54ad1`

Source scope: `src/components/portal/pro-tours.tsx`, `src/lib/agent/leasing-sms-agent.server.ts`, `src/lib/sms/owner-sms-dispatcher.server.ts`, `src/lib/sms/tour-sms-eligibility.server.ts`, `src/lib/tools/context.ts`, `src/lib/tools/domains/tours.ts`, `src/lib/tour-inquiry-confirm.server.ts`, `src/lib/tour-inquiry-create.server.ts`, `src/lib/tour-inquiry.server.ts`, `src/lib/tour-notification-delivery.server.ts`, `src/lib/tour-notifications.ts`, `src/lib/tour-planned-change.server.ts`, and `src/lib/tour-reschedule-sms-reply.server.ts`.

Test scope: `tests/unit/sms-conversation-log-dispatch.test.ts`, `tests/unit/tools/tours.test.ts`, `tests/unit/tour-confirm-google-sync.test.ts`, `tests/unit/tour-email-skips-sandbox.test.ts`, `tests/unit/tour-guest-sms-consent.test.ts`, `tests/unit/tour-notifications.test.ts`, `tests/unit/tour-planned-change.test.ts`, `tests/unit/tour-reschedule-sms-reply.test.ts`, `tests/unit/prp-473-tour-sms-eligibility.test.ts`, and `tests/unit/tour-lifecycle-sms-provenance.test.ts`.

Consulted root/matching Akhil instructions, ship gate, tour/SMS area documentation, original and correction plans, review-3 and correction-2 Bugbot/security evidence, resumed plan/handoff, and the fresh resumed security report. Unrelated backlog, sibling-issue, copied workflow, and private account artifacts are outside this review. The known graph CLI mismatch and absent current graph prevent using graph results; no graph artifact was created.

## Closed P2: repaired snapshot is preserved in final consumption

`src/lib/tour-reschedule-sms-reply.server.ts:100` compares the original source/event/owner, row and proposal generations, exact phone pair, window, version, status, conversation key, request timestamp, origin and consent. `:119` applies the same comparison to the upgraded proposal. The guard is captured at `:362`, checked on the recursive inventory reread at `:486`, and bound to the final candidate's record/event identity at `:538`.

Pending YES receives that guard and checks it inside its final CAS callback at `:447`. Planned YES and alternate-time replies check it inside their final callback at `:582`. `casPlannedRows` invokes those closures on every bounded retry, so a failed write never replaces the original snapshot with the competitor's new state. A same-id row in the other singleton is not an interchangeable reply target.

Independent replay of the earlier failure harness now returns `stale` for each of five isolated mutations at final read 6: `smsOrigin`, `sourceInquiryId`, `conversationKey`, `requestedAt`, and `smsConsent`. Each case reached the contested read, retained the competitor field, performed exactly one successful eligibility-repair write, retained `awaiting_reply`, and did not persist an inbound SID. This is executed evidence that the original planned final-read defect is closed, not an inference from green tests.

The repository test matrix at `tests/unit/tour-reschedule-sms-reply.test.ts:418` and `:495` covers planned and pending omitted-field races. The failed-final-CAS matrix at `:669` covers planned YES, planned alternate time, and pending YES. Its replacement is cloned from the already-upgraded row at the contested read, changes one omitted field while retaining id/version/generation/status/eligibility, advances the fake database token, and asserts the exact competitor survives. This avoids the earlier weak fixture that could pass solely on an old terminal/id predicate. Cross-record retargeting is exercised at `:766`.

## Closed P2: mixed inventories establish uniqueness before selection

The shared structural predicate at `src/lib/tour-reschedule-sms-reply.server.ts:341` covers planned and pending candidates, modern and legacy eligibility shapes, owner, exact stored/current phone pair, active/pending state, window, status/version and row-generation agreement. Both inventories enter selection at `:512`.

Every structurally eligible legacy candidate is resolved at `:403`. Only the narrow four-reason definitive-denial allowlist at `:332` permits excluding one. Exceptions and other failure reasons remain unresolved. Resolved/stored conversation-key mismatch is explicitly unresolved at `:414`, preserving its ability to block an unsafe modern singleton. Multiple candidates or any unresolved authority enter manager follow-up at `:520`; only one authorized legacy candidate can be repaired.

Independent replay with two legacy proposals and one modern proposal, on distinct future dates/properties and with the real active-tour helper, now returns `ambiguous`, makes zero proposal writes, and leaves all three proposals awaiting reply. The prior implementation confirmed modern in precisely this scenario.

Tests also cover one legacy plus modern, legacy-only ambiguity, mixed planned/pending inventories, unreadable authority, key mismatch, definitive exclusion, generationless legacy success and structurally invalid candidates. The race tests mock the authority resolver deliberately; the separate lifecycle tests exercise the actual resolver and notifier with persistence/provider boundaries mocked. These are complementary scopes of evidence, not end-to-end provider acceptance.

## Accumulated-contract review

- Both confirmation implementations preserve stored SMS provenance. Planned cancel/reschedule projects the authorized stored manager into the real notifier. The lifecycle tests invoke the actual confirmation/planned-change/notifier/resolver chain and verify owner, exact conversation scope, canonical inbox persistence, signed Reply-To and proposal creation. The first two lifecycle test descriptions still interchange “confirm” and “accept”; both actual callers are covered, so this is not a correctness blocker.
- Leasing tool requests explicitly distinguish SMS, voice and email, bind an SMS request to the normalized inbound sender, and do not expose model-authored consent. Public creation strips incoming `smsOrigin`. New non-SMS records cannot become historical SMS-origin records by crossing confirmation/projection boundaries.
- Eligibility retains suppression, purpose revocation, trusted scoped conversation evidence and evidence timestamps. Derived grants are revalidated at the five-purpose managed-dispatch boundary. Explicit opt-in and independently restored purpose grants remain distinguishable from conversation-derived grants.
- Modern replies preserve the existing server-recorded marker semantics. Legacy replies require current authority before repair. Duplicate SID, terminal/canceled state and generation guards remain. Pending YES records acceptance without booking. Planned alternate-time replies require a delivered manager notice before their guarded terminal write; notice failure leaves the proposal actionable. Pending alternate-time retains its existing non-terminal follow-up contract.
- Notification results keep accepted/queued separate from sent and propagate provider/outbox identifiers. A failed reply-state write after accepted SMS is surfaced. Configured email replies attach the existing signed Reply-To to the actual payload. Generated defaults use available reply facts, conservative client defaults remain conservative, and custom manager prose remains intact.
- No new route, navigation, polling, cache, client dependency or native-specific UI path was introduced. Eligibility reads should remain uncached because they authorize the current send. No additional cache/rendering/native regression was established in this bounded diff.

## Independent probe and validation provenance

The following no-file command was run from the worktree under Node 22.23.0 with a 4GB heap and disabled providers. It adapts the retained correction-2 harness to assert the fixed behavior, uses the actual active-tour helper, and makes stored/resolved keys canonical. Exit 0.

```bash
env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 node <<'NODE'
const fs=require('node:fs'), ts=require('typescript');
const report=fs.readFileSync('docs/security/2026-09-10-prp-473-correction-2-security-review.md','utf8');
let probe=report.match(/node <<'NODE'\n([\s\S]*?)\nNODE\n/)[1];
const activeSource=fs.readFileSync('src/lib/tour-slot-math.ts','utf8').match(/export function isActivePlannedTourEvent\([\s\S]*?\n\}/)[0];
const m={exports:{}};
new Function('exports',ts.transpileModule(activeSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m.exports);
probe=probe.replace('e => !e.canceledAt',m.exports.isActivePlannedTourEvent.toString());
probe=probe.replace('function event(id, eligible) {',`function event(id, eligible) {
 const day = id === 'legacy-1' ? '13' : id === 'legacy-2' ? '14' : '12';
 const start = '2099-09-' + day + 'T18:00:00.000Z';
 const end = '2099-09-' + day + 'T18:30:00.000Z';`);
probe=probe.replace('return { id, sourceInquiryId:',"return { id, kind: 'tour', propertyId: 'property-' + id, sourceInquiryId:");
probe=probe.replaceAll("'original-key'","'manager-1:prospect:+12065550100'").replaceAll("'owner:prospect:phone'","'manager-1:prospect:+12065550100'");
probe=probe.replace("assert.equal(result.contested,true); assert.equal(result.writes,2);", "assert.equal(result.contested,true); assert.equal(result.reads,6); assert.equal(result.writes,1);");
probe=probe.replace("assert.equal(reply.kind,'confirmed'); assert.equal(result.rows[0].guestRescheduleReply.status,'confirmed');",`assert.equal(reply.kind,'stale'); assert.equal(result.rows[0].guestRescheduleReply.status,'awaiting_reply');
assert.equal(result.rows[0].guestRescheduleReply.inboundMessageSid,undefined);
assert.equal(mutation === 'smsOrigin' ? result.rows[0].smsOrigin : mutation === 'sourceInquiryId' ? result.rows[0].sourceInquiryId : mutation === 'smsConsent' ? result.rows[0].smsConsent : result.rows[0].guestRescheduleReply[mutation], mutation === 'smsOrigin' ? 'non_sms' : mutation === 'sourceInquiryId' ? 'different-inquiry' : mutation === 'smsConsent' ? true : 'changed');`);
probe=probe.replace("assert.equal(reply.kind,'confirmed'); assert.equal(result.writes,1);","assert.equal(reply.kind,'ambiguous'); assert.equal(result.writes,0);");
probe=probe.replace("['confirmed','awaiting_reply','awaiting_reply']","['awaiting_reply','awaiting_reply','awaiting_reply']");
new Function('require',probe)(require);
NODE
```

Observed: all five final-CAS cases reported `kind: stale`, `reads: 6`, `writes: 1`, `contested: true`. Mixed inventory reported `kind: ambiguous`, `writes: 0`, statuses `[awaiting_reply, awaiting_reply, awaiting_reply]`.

Independent HEAD/SHA checks and `git diff --check` completed with exit 0. No compiler or unit suite was duplicated by this delegate. Parent independently reports the ten-file affected run at 189 tests, exit 0, 11.60 seconds. The resumed implementation handoff reports focused 54 tests, integration 11 tests, full unit 9,483 tests, lint, TypeScript and build passing; those are attributed to their runners. The final test-only retry strengthening followed the full-unit run, with focused and TypeScript reruns afterward.

## Acceptance boundaries

The resumed handoff records real dev browser mutation, durable exact-generation inbox message, recipient rendering, desktop/mobile preview and duplicate-submit rejection. This reviewer did not repeat cloud/browser writes or independently establish handset delivery. Real provider receipts, STOP/START/YES/alternate-time handset round trips, email provider routing and staging QA remain pending.

Remote main/production dependency drift to `2d1353af42c3a652be6cf8a69640468b453f4cea`, absent remote staging, and the reported `ship:preflight` exit 1 remain release prerequisites. Later captain integration requires validation of the integrated source. Keeper approval cannot bypass protected-branch rules or staging.

Only this report was written. No source/test edit, database/provider write, credential change, commit, push, merge, deployment, tracker action, graph mutation or no-mistakes invocation occurred.
