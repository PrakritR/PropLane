# PRP-473 resumed security review

Date: 2026-09-10. Independent security-review delegate for the mandatory review in `docs/ship-gate.md`.

## Snapshot and disposition

Keeper: `akhil/backlog-repeat-issues`. Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Base and observed HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`. This review covers the accumulated uncommitted PRP-473 implementation, not a prospective integrated or deployed commit. Independently verified reply-module SHA-256: `a75cd1caf2d02bf6a4da3ba61353240fd0f765b63d64bf5e14d9ebcc9a1ecbe5`.

No new actionable security finding established. Both Medium findings in the correction-2 security report are closed in this snapshot. Security disposition: acceptable for keeper handoff, subject to the other required reviews. This is not production approval or handset acceptance.

## Scope

Inspected the actual accumulated source diffs and the untracked resolver, covering all 13 source files:

- `src/components/portal/pro-tours.tsx`
- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/sms/owner-sms-dispatcher.server.ts`
- `src/lib/sms/tour-sms-eligibility.server.ts` (untracked)
- `src/lib/tools/context.ts`
- `src/lib/tools/domains/tours.ts`
- `src/lib/tour-inquiry-confirm.server.ts`
- `src/lib/tour-inquiry-create.server.ts`
- `src/lib/tour-inquiry.server.ts`
- `src/lib/tour-notification-delivery.server.ts`
- `src/lib/tour-notifications.ts`
- `src/lib/tour-planned-change.server.ts`
- `src/lib/tour-reschedule-sms-reply.server.ts`

Also inspected reply regression fixtures, selected existing authority/dispatch/reply-address dependencies, root and Akhil instructions, ship gate, relevant SMS/tour architecture documentation, the original and correction plans, resumed plan/handoff, and correction-2 security evidence. Unrelated backlog, sibling-issue, copied workflow, and private browser artifacts are outside the security change scope. No migration, new endpoint, RLS policy, or database privilege change is present in the reviewed implementation.

## Prior findings and evidence of closure

### Closed P2 / Medium: final consumption lost the repaired legacy snapshot

`src/lib/tour-reschedule-sms-reply.server.ts:100` defines the complete legacy comparison; `:119` applies it to the upgraded shape. The repair guard captures source inquiry, event, owner, exact phone pair, window, row/proposal generation, version, status, conversation key, request timestamp, origin, and consent at `:362`.

The guarded reread at `:486` remains, and final target selection additionally preserves record identity at `:538`. Pending final consumption receives the guard at `:559` and checks it inside the CAS mutation at `:447`. Planned YES and alternate-time consumption check the same guard at `:582`. Because the callback closes over the original guard and `casPlannedRows` invokes it on each bounded retry (`:151`), a competing change cannot become the next authorized snapshot. A mismatch returns stale without the final SID/status write. Repair cannot silently move from planned to pending when event ids coincide.

The inspected tests at `tests/unit/tour-reschedule-sms-reply.test.ts:418` and `:495` vary the five previously omitted fields after upgrade and guarded reread. The retry matrix at `:669` advances the fake database token, clones the already-upgraded contested row, changes only an omitted field, forces a failed final CAS, and asserts the exact competitor survives with no SID. This addresses the prior risk of a passing fixture exercising only an already-covered terminal/id mismatch. Planned alternate-time and pending YES use the same guard; pending alternate-time retains its existing non-terminal manager-notice behavior.

### Closed P2 / Medium: mixed inventories dropped actionable legacy proposals

The shared structural predicate at `src/lib/tour-reschedule-sms-reply.server.ts:341` covers both inventories and both proposal generations. It checks owner, stored/current recipient, original work number, window, status, version, row-generation agreement, and active/pending semantics. Both complete loaded inventories enter candidate selection at `:512`.

Each structurally actionable legacy candidate is checked against the existing eligibility resolver at `:403`. Only the explicit denial allowlist at `:332` removes a candidate definitively. Exceptions and unrecognized/unreadable authority stay unresolved. Resolved/stored conversation-key disagreement is explicitly unresolved at `:414`, so it cannot create an apparent modern singleton. `:520` prevents confirmation when any candidate is unresolved or more than one remains. Only a unique authorized legacy candidate is repaired, then it is reread under the fixed guard.

Inspected regressions include two legacy plus modern (`tests/unit/tour-reschedule-sms-reply.test.ts:543`), unreadable authority (`:594`), key mismatch (`:641`), single legacy plus modern (`:723`), definitive denial (`:744`), cross-record identity (`:766`), and legacy-only/mixed-inventory ambiguity (`:804`, `:824`). Notice failure returns unavailable and retains actionable proposals rather than reporting a completed confirmation.

## Accumulated security boundaries

- Public creation strips caller-supplied `smsOrigin`. Leasing requests derive channel from server scope, bind the submitted phone to the inbound sender, and do not accept a model-authored SMS consent grant. Explicit channel includes voice and email. Both confirmation writers and planned-event projection preserve provenance, preventing a known non-SMS request from becoming an apparently historical SMS record.
- Planned changes retain the stored authorized event owner through notification context. Consent lookup, outbound conversation identity, canonical inbox append, signed Reply-To, and proposal recording use that owner. No caller-selected owner becomes new authorization.
- The resolver requires normalized recipient, manager, authoritative service, transactional purpose, and prospect conversation scope. Global suppression and current purpose revocation fail closed. Positive conversation evidence is restricted to the trusted inbound/START sources, preserving source timestamp and explicit derivation metadata. Newly marked non-SMS requests without opt-in cannot obtain conversation-derived authorization.
- The dispatcher change is limited to the five tour lifecycle purposes. Existing sender assignment, runtime, campaign/service, entitlement, suppression, and scoped-consent gates remain. Conversation-derived purpose grants additionally require current source-conversation authority at the outbox policy boundary. Explicit tour opt-in and independently restored purpose grants remain distinct from derived grants.
- Modern reply proposals use their server-recorded eligibility marker and exact stored phone-pair/generation identity; legacy proposals require current eligibility before upgrade. These are reply-state semantics, not permission to bypass outbound consent. Pending YES records guest acceptance without booking the inquiry. Duplicate SID, terminal state, canceled tour, and generation checks remain in place.
- Email Reply-To reuses the existing recipient/owner HMAC helper and is attached to the actual outbound payload. Missing configuration yields conservative default copy. The existing forwarded-address/From-spoofing residual of that helper is unchanged. No private manager email is introduced as a fallback.
- Lifecycle summary metadata excludes recipient phone, email, message body, and free-form provider errors. Provider accepted/queued state remains separate from handset delivery. Generic tracing exception handling was not independently audited as a new subsystem.

## Validation provenance and production gates

Independent work in this review consisted of read-only source/document inspection, SHA-256 verification, and `git diff --check` (exit 0). No compiler, test suite, browser action, database access, or provider call was run by this delegate. The only file written is this report. No source edits, commit, push, merge, deployment, tracker action, graph artifact generation, or no-mistakes invocation occurred.

The resumed handoff reports focused 54/54, affected 189 tests, integration 11 tests, full unit 9,483 tests, TypeScript, lint, and build passing. Those are implementation/root-attributed results, not independently rerun security-review results. The parent independently reran the ten-file affected suite and reported exit 0, 189 tests, 11.60 seconds during this review. The final test-only retry strengthening postdates the full-unit run; the handoff records focused and TypeScript reruns afterward. Known graph hook/CLI incompatibility remains documented rather than being represented as a successful graph refresh.

Real handset delivery receipts, STOP/START, inbound YES and alternate-time handset behavior, actual email routing, staging QA, and protected-branch captain integration remain separate release requirements. The handoff reports `ship:preflight` exit 1 with missing remote staging and environment/dirty-keeper warnings. This review neither resolves those gates nor permits bypassing them. Any later integration with newer main/production changes needs validation against that integrated source.
