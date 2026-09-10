# PRP-473 correction 2 bugbot review

Date: 2026-09-10. Fresh mandatory bugbot review under `docs/ship-gate.md`.

Disposition: changes required. Two P2 correctness findings remain. This is the final automatic review; do not initiate another correction cycle. No P0/P1 finding was established in this review.

## Scope

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Keeper: `akhil/backlog-repeat-issues`. Base and HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`. Reviewed the complete uncommitted PRP-473 source/test changes against that base, including untracked resolver and lifecycle tests. No commit represents this dirty snapshot.

Source scope: `src/components/portal/pro-tours.tsx`, `src/lib/agent/leasing-sms-agent.server.ts`, `src/lib/sms/owner-sms-dispatcher.server.ts`, `src/lib/sms/tour-sms-eligibility.server.ts`, `src/lib/tools/context.ts`, `src/lib/tools/domains/tours.ts`, `src/lib/tour-inquiry-confirm.server.ts`, `src/lib/tour-inquiry-create.server.ts`, `src/lib/tour-inquiry.server.ts`, `src/lib/tour-notification-delivery.server.ts`, `src/lib/tour-notifications.ts`, `src/lib/tour-planned-change.server.ts`, and `src/lib/tour-reschedule-sms-reply.server.ts`.

Test scope: changed files under `tests/unit/`: `sms-conversation-log-dispatch.test.ts`, `tools/tours.test.ts`, `tour-confirm-google-sync.test.ts`, `tour-email-skips-sandbox.test.ts`, `tour-guest-sms-consent.test.ts`, `tour-notifications.test.ts`, `tour-planned-change.test.ts`, `tour-reschedule-sms-reply.test.ts`, plus untracked `prp-473-tour-sms-eligibility.test.ts` and `tour-lifecycle-sms-provenance.test.ts`. Read original root AGENTS, matching Akhil instructions, ship gate, original plan, correction-2 plan/handoff, review-2 and current security report. Unrelated backlog, sibling and copied workflow artifacts are excluded.

The current reply module SHA-256 is `5ae896e2398d07ea04ab481e9cb93063d55da8cefd9d0904cc6c5447d0216f7b`. Owner projection module SHA-256 is `ae73116f8859444c08d792c65988437b81e4ba1ac97a02d6736f6c39c9ab3ba5`.

## P2 - Keep the original repaired snapshot in the final consumption CAS

Locations: `src/lib/tour-reschedule-sms-reply.server.ts:413`, `:573`, `:578`; equivalent pending final mutation at `:357` / `:361`.

The new guard validates repaired A during the recursive inventory read, but the later planned final CAS no longer uses that guard. Its predicate checks generation, version, current owner, phone pair, status and window, while omitting source inquiry, origin/consent, conversation key and request timestamp. A concurrent update to any of those omitted snapshot fields after the guarded read is accepted and the inbound SID is consumed as confirmation of the changed row. The database timestamp CAS does not prevent this: the callback reads the competitor's new timestamp and writes against it.

Independently replayed the retained security probe against the actual current reply module, replacing the active-tour stub with the real transpiled helper and using valid `kind: 'tour'` fixtures with future dates. On final CAS read 6, separately changing `smsOrigin`, `sourceInquiryId`, `conversationKey`, `requestedAt` or `smsConsent` while advancing `updated_at` still returned `confirmed` in all five cases. Each case performed two writes: eligibility repair and reply consumption. The changed field survived in the confirmed row. This corroborates the security finding; it does not demonstrate cross-owner access.

Carry the same upgrade snapshot through the planned and pending final mutation callbacks and enforce it on every retry. Add an adversarial update after the guarded reread, not just immediately after the repair write. Existing immediate post-repair replacement tests end one read too early to cover this gap. The planned failure is executed evidence; the pending equivalent is source-reviewed.

## P2 - Include eligible legacy proposals in mixed ambiguity detection

Locations: `src/lib/tour-reschedule-sms-reply.server.ts:397`, `:440`, `:522`.

Modern candidate selection excludes proposals without `smsEligibility`. Legacy repair runs only if exactly one legacy candidate exists. If the same guest/work-number pair has two actionable legacy proposals and one modern proposal, both legacy rows disappear from the subsequent ambiguity count. A generic YES confirms the modern proposal even though there is no evidence identifying which tour the guest means.

The independent probe used three distinct future dates and distinct properties, internally consistent generation/version/window values, the same owner and exact phone pair, and a positive mocked scoped eligibility resolver. Both legacy fixtures have SMS origin and are repair candidates. The current code returned `confirmed`, wrote once, and left proposal statuses `[confirmed, awaiting_reply, awaiting_reply]`. The two legacy candidates never reached the resolver because their count skipped the repair branch. This is a real target-selection error rather than a fixture with conflicting simultaneous tours.

Determine ambiguity across all actionable authorized modern and legacy proposals before consuming the reply, including planned/pending combinations. When uniqueness cannot be established, fail closed or route the message for manager follow-up. Add two-legacy-plus-one-modern coverage; the existing modern planned/pending ambiguity test does not cover this branch.

## Other review conclusions

- The earlier missing-owner defect is corrected: `inquiryFromPlannedEvent` retains the authorized stored manager, and both planned callers pass that manager through the window. The real caller/resolver lifecycle tests now exercise notification delivery, purpose evidence, canonical inbox append and signed Reply-To. Two test descriptions swap the words confirm/accept relative to their actual callers; both actual callers are nevertheless covered.
- The repair is now upgrade-only during its own CAS, preserves the initial snapshot across retry attempts, refuses stale row generations and prevents unbounded recursive repair. These corrections address the previously demonstrated A-to-terminal-B overwrite and immediate post-upgrade retargeting; they do not close the final-CAS gap above.
- The sender-context phone check and explicit channel prevent email/voice requests from inheriting SMS origin. Both confirmation implementations preserve origin. The resolver and five-purpose dispatch guard retain scoped consent, suppression and derived-source revalidation.
- Notification results preserve sent versus accepted and retain SID/outbox status. A failed proposal write is surfaced after accepted SMS. Generated reply instructions use available channel facts; custom prose remains intact. The conservative editable preview remains an account-path message even when signed email replies are configured, as deliberately documented in review-2. No additional copy defect is asserted.
- No new client fetch, polling, navigation or native-specific branch was introduced. Detailed browser and actual provider acceptance remain the parent review's responsibility. The handoff's successful durable dev inbox evidence is not handset delivery evidence.

## Commands, evidence and limits

`git rev-parse HEAD`, scoped `git diff`, source/test reads and SHA-256 inspection completed with exit 0. `git diff --check` exited 0. A combined `ls` graph-state check exited 1 because `.graphify/graph.json`, wiki index, needs-update and branch sidecar are absent; no graph state was written or refreshed. The handoff records the installed CLI incompatibility. Current source is the authority for all cited lines.

No compiler or unit suite was duplicated. Parent reported its final focused run at 10 files / 164 tests, exit 0; the implementation handoff separately reports full unit, lint, TypeScript and build success. Those results are attributed to their runners, not claimed as independently executed here. The missing cases above explain why green existing suites do not resolve the findings.

The following no-file command independently executed the actual reply code using the retained security harness, the actual active-tour helper and improved distinct-window fixtures. It exited 0 on Node v22.23.0. Exit 0 means the assertions reproduced the defects, not that product behavior passed.

```bash
PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 node <<'NODE'
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
console.log('Bugbot: real active-tour predicate and distinct future windows/properties');
new Function('require',probe)(require);
NODE
```

All five final-CAS probe rows reported `kind: confirmed`, `reads: 6`, `writes: 2`, `contested: true`. The mixed proposal row reported `kind: confirmed`, `writes: 1`, `statuses: [confirmed, awaiting_reply, awaiting_reply]`. An earlier same-window replay also exited 0; the distinct-window replay above is the stronger retained evidence.

No database/provider access or writes, source/test edits, commit, push, PR, tracker update, protected merge or no-mistakes invocation occurred. The only written file is this report. Staging and real provider/handset acceptance are not established by this review.
