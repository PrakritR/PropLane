# PRP-473 correction 1 security review

Date: 2026-09-10. Independent security-review delegate under `docs/ship-gate.md`.

Scope: keeper `akhil/backlog-repeat-issues` in the pool worktree, base and current HEAD `0b6d56794407277761ad5f6c680a522e97db2e6d`, plus the current uncommitted PRP-473 source/test diff and untracked `src/lib/sms/tour-sms-eligibility.server.ts` and its tests. This includes the late alternate `acceptTourInquiry` projection and the exact dispatcher purpose allowlist. Planning/workflow artifacts belonging to other tasks are excluded. This report certifies neither a later commit nor a changed diff.

Read the supplied root instructions, Akhil developer instructions, ship gate, SMS/tours/agent/inbound-email architecture notes, original plan, correction plan and correction handoff, and initial security findings. No source edits, external sends, database writes, compiler suites, additional delegates, or production operations were performed. The only file written is this report. The established incompatible graph CLI was not rerun.

## Finding

### P2 - Legacy repair can overwrite a newer terminal proposal and confirm an obsolete generation

Locations: `src/lib/tour-reschedule-sms-reply.server.ts:328` calls the general proposal recorder for legacy repair without an expected proposal snapshot; the recorder's same-operation decision is at line 144 and its new-proposal fallback starts at line 171. Planned reply matching at line 291 and its final CAS predicate at line 424 do not compare the proposal generation with the event's `rescheduleNotificationGeneration`.

The initial legacy candidate filter validates generation and status, but those facts are not preserved as preconditions on the recorder's later read. If another operation replaces legacy generation A with generation B for the same event/window/phone before that read, `isSameOperation` becomes false. The terminal guard only applies when it is true. The recorder therefore replaces even an already confirmed B proposal with a fresh `awaiting_reply` A proposal. The recursive planned reply handler then accepts A because it checks its internally consistent version/window but never compares A to the row's current generation B. This violates the correction requirement to upgrade only the exact still-actionable snapshot and never reopen terminal state.

Independently reproduced with a local in-memory harness that transpiled and executed the actual current `tour-reschedule-sms-reply.server.ts`; all imports and storage were mocked and no files or external state were changed. The fake ledger granted eligibility to isolate the snapshot boundary. After planned/inquiry inventory reads, the third read deliberately replaced A with confirmed B while preserving the window. The actual handler performed two writes and returned `kind: confirmed`. Final state was:

```json
{"contested":true,"reads":6,"writes":2,"rowGeneration":"generation-B","proposalGeneration":"generation-A","proposalStatus":"confirmed"}
```

Harness exit code: 0, including assertions that the contested read happened, two writes occurred, and A was confirmed over B. The existing corrected CAS fixture does not cover this legacy-upgrade transition.

Required correction: give legacy repair an upgrade-only CAS with the originally selected event id, proposal version/generation/work number/status, row generation and provenance as predicates. Reject any snapshot change instead of falling through to proposal creation. Also require current row generation agreement in planned reply matching and the terminal CAS, as the pending-inquiry path already does. Add a regression for generation B becoming terminal during legacy A repair, plus work-number/provenance changes during that same re-read.

## Initial security findings resolved

- START-derived retry revocation: resolved in the reviewed source. Materialization stores `conversationPurpose`, source and the original source timestamp (`tour-sms-eligibility.server.ts:220`); the existing-purpose path rechecks current exact scoped conversation authority whenever that evidence marks derivation, for both trusted sources (`:171`). Independently restored purpose grants and explicit opt-in remain distinct. Global suppression and exact-purpose revoke checks still precede grants.
- Delayed dispatch after source revoke: resolved in the reviewed source. `owner-sms-dispatcher.server.ts:170` invokes the new final policy helper; that helper rereads the exact-purpose event and its current source conversation, refusing missing/revoked/unreadable authority (`tour-sms-eligibility.server.ts:93`). The allowlist at dispatcher line 24 contains exactly `tour_request_received`, `tour_request_removed`, `tour_confirmed`, `tour_rescheduled`, and `tour_canceled`; manager alerts/reminders and unrelated application/control semantics are not broadly changed. The queued-after-revoke provider-mock regression exercises the actual new policy helper.

## Other reviewed boundaries

- Both live confirmation implementations preserve stored boolean consent and string origin: `tour-inquiry-confirm.server.ts:299` and `tour-inquiry.server.ts:198`. Planned cancel/reschedule projection also retains origin (`tour-planned-change.server.ts:59`). The notification eligibility boundary rejects known non-SMS origin without explicit opt-in before consulting historical conversation evidence. The actual-resolver lifecycle regression covers this transition.
- Public inquiry input cannot stamp `smsOrigin`; creation strips it and derives the marker from the server-only argument. Leasing SMS tools bind the supplied phone to authenticated sender context, with explicit SMS/voice/email channel propagation. No new model-authored consent parameter or tenant scope was introduced.
- Consent reads constrain owner, normalized phone, Messaging Service, transactional class, purpose and conversation key. Missing scope, global suppression and unreadable authorization state block sends. No new SQL, schema grants or RLS changes are present.
- Default email reply claims depend on the same signed Reply-To attached to the outbound payload. The existing helper binds manager id and guest email, with absent configuration returning null. The fallback uses established account URLs rather than exposing a private manager address. This review does not reassess the documented existing forwarded-token/From-spoofing residual.
- Lifecycle trace summaries use ids, enums and delivery identifiers, excluding phone, email, body and free-form provider errors. Accepted/queued outcomes remain separate from sent outcomes.

## Validation limits and disposition

The targeted in-memory race reproduction was independently executed. Implementation handoff test/lint/typecheck/build results were inspected but not rerun in this security pass. No real handset, provider, STOP/START round trip, inbound email delivery, staging or production verification was performed. The outstanding P2 requires correction and a fresh review of the resulting diff before this security gate can pass.
