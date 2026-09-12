# Prospect SMS security review after correction cycle 1

Date: 2026-09-12. Independent correction-scope review for Akhil.

Verdict: **SEC-1 resolved; changes still required before accepting the proposed Claw rail.** The new atomic preparation closes the demonstrated stranded-outbox race. Two defects remain beneath the new Claw dispatcher branch: an ambiguous provider result can trigger a second submission inside the provider helper, and unreadable suppression data is treated as permission to send. Both are currently latent because the real Claw configuration function unconditionally disables that rail. No new unauthenticated write, cross-tenant disclosure, or client-controlled sender path was established.

Review coordination decision: root Astra subsequently confirmed that Claw must remain retired and correction cycle 2 will restrict supported durable replies to manager-owned Twilio. Removing the new managed Claw linkage and rejecting unsupported rail state without a silent sender/transport fallback is an acceptable resolution of SEC-2/SEC-3. This review does not request Claw reactivation and does not yet mark that planned correction as implemented or verified.

## Snapshot and scope

- HEAD: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, branch `prospect-agent-eval-loop`; uncommitted correction files identified in `docs/plans/prospect-sms-single-reply-correction-handoff.md` only. Unrelated dirty work was excluded.
- Independently verified migration SHA-256: `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`.
- Read root/Akhil instructions, SMS architecture, original plan and security review, correction plan and handoff, and database probe evidence. Graphify supplied initial orientation, but its legacy query output and documented tooling mismatch are not proof of the current correction; current source determined findings.
- Scope: atomic outbox preparation, lock order, lease/revision/identity fencing, service-only RPC privileges, and the new managed Claw dispatch/consent/provider boundary. Parallel Astra review owns the consolidated correction decision and broader comparison/incident-fixture findings.
- This report is the only repository file authored by this reviewer. No implementation edits, shared database activity, external messages, network provider calls, paid keys, release, commit, PR, Linear, or no-mistakes execution.

## Resolved SEC-1: atomic preparation eliminates the demonstrated race

Locations: `src/lib/sms/owner-sms-dispatcher.server.ts:219`; `supabase/migrations/20260912143000_prospect_sms_bursts.sql:207`, `:223`, `:243`, `:246`, `:258`, `:284`.

The runtime now calls `prepare_prospect_sms_delivery` without publishing a standalone outbox row. The RPC locks the burst, validates manager, recipient and transport against its service-owned identity, validates the generation revision/lease, inserts the unique intent, and attaches it in one transaction. Failure rolls back both writes. Preparation and submission both lock burst before outbox, eliminating the former inverse lock order. An existing intent is observed only in an already-prepared correlated state; preparation does not transition an uncertain or terminal submission back to a sendable state.

The root reviewer independently applied/reapplied the exact final migration against isolated PostgreSQL with actual baseline outbox/attempt DDL and ran 78 SQL assertions, all exit 0. That evidence includes uncommitted-row invisibility, rollback/crash recovery, concurrent preparation, prepare/submit lock ordering, mismatched manager/phone/rail rejection, stale revision rejection, and submitted/unknown non-revival. See `docs/plans/prospect-sms-db-probe.md`. This reviewer inspected that evidence and the exact hashed source; the 78 assertions were not independently rerun here.

## SEC-2: P1 - New managed Claw send calls a helper that retries an unknown submission

Locations: `src/lib/sms/owner-sms-dispatcher.server.ts:603`; `src/lib/claw-messenger.server.ts:231`, `:239`, `:241`, `:261`.

The new durable dispatch branch invokes `sendClawMessengerText` once after the SQL submission fence, but that helper can submit twice. It sends a frame, waits for a correlated result, and retries any WebSocket/timeout error through a fresh socket. Each attempt creates a new correlation ID. If the first frame was accepted and its result is lost or the socket closes, the second frame repeats the same message with a new ID. The outbox cannot prevent this retry because it occurs inside its one provider call. If the second attempt succeeds, the outbox records success despite the possible duplicate first acceptance.

Local evidence: transpiled the actual helper with TypeScript and ran it in a VM using an in-memory EventEmitter WebSocket implementation and a synthetic key. The first socket recorded a send and closed before returning a result; the second returned success. Result: **two identical recipient/body frames, two different correlation IDs, helper success**. Seven assertions passed, exit 0; zero network calls. This establishes the unsafe retry behavior, not actual provider delivery of either frame.

Reachability qualification: `isClawMessengerConfigured()` at `src/lib/claw-messenger.server.ts:35` returns `false` unconditionally. The new caller rejects Claw at `src/lib/proplane-sms-transport.server.ts:149`, and dispatch defers it at `src/lib/sms/owner-sms-dispatcher.server.ts:454`. Therefore this is a latent defect in the proposed supported rail, not an exploitable active production path in this snapshot. The correction tests replace configuration with `true` and replace the send helper with a single mock, hiding the nested retry (`tests/unit/prospect-sms-outbox-dispatch.test.ts:9`).

Required correction: first reconcile the approved dual-ingress requirement with the repository's explicit Claw retirement invariant; do not reactivate the rail implicitly. If retained as supported scope, provide a send primitive with no retry after a frame may have left the process, propagate uncertainty to the durable outbox, and test socket close/timeout after send using the real helper with a provider stub. A retry is safe only when no submission could have occurred. Preserve runtime-derived sender identity.

## SEC-3: P2 - New managed Claw gate fails open on suppression-store errors

Locations: `src/lib/sms/owner-sms-dispatcher.server.ts:450`; `src/lib/sms/transport-gate.server.ts:15`; `src/lib/sms-consent.ts:282`, `:293`, `:322`. Existing fail-closed alternative: `src/lib/sms-consent.ts:67`.

The newly added Claw dispatch branch uses the extracted legacy `transportGateBlocks`, which calls `isPhoneOptedOut`. That helper discards Supabase error results; the wrapper also catches thrown errors and returns no blocker. If a prior STOP is in an unavailable suppression store, the check has no evidence of that STOP and permits dispatch. Managed Twilio instead uses `readSmsSuppressionState`, which preserves infrastructure errors and defers the outbox. Reusing the legacy helper at the new managed boundary weakens that existing durable-dispatch invariant.

Local evidence: executed the actual consent module and actual new gate in a VM with a database stub returning `{data:null,error:{...}}` for both suppression stores. The legacy helper returned `false`, the new gate returned `null` (allowed), while the existing managed helper returned `{ok:false,error:'suppression_ledger_unreadable'}`. Four assertions passed, exit 0; zero network calls. The separate seven-assertion probe also confirmed that a thrown suppression lookup is allowed. Existing STOP testing stubs the entire gate to return a blocker and does not cover this error behavior.

This finding has the same current Claw-retirement reachability limitation as SEC-2. The old synchronous gate already failed open; this review does not present that old behavior as a newly introduced active exploit. The correction newly installs it as the sole suppression check on a proposed durable rail.

Required correction if the rail remains in scope: use the established fail-closed suppression reader for managed Claw, retain unreadable outcomes as retryable deferrals, and test ledger failure, profile failure, thrown failure, and STOP inserted after preparation with the actual gate. A durable queue can wait for consent infrastructure to recover without dropping the candidate or interpreting missing evidence as permission.

## Other controls and limitations

- All seven new mutation RPC signatures pin `search_path`, revoke execution from PUBLIC/anon/authenticated, and grant service-role execution. New tables enable RLS and revoke anon/authenticated access (`supabase/migrations/20260912143000_prospect_sms_bursts.sql:329`). The changed preparation signature is included. Root's SQL probes establish client-role denial on the isolated schema, not deployed Supabase grants.
- Callback payloads still carry only burst ID/revision. Transport/catalog/recipient/owner values are read from service-owned burst rows (`src/app/api/internal/prospect-sms-burst/route.ts:54`). New ingress chooses transport/catalog from its trusted server entry path. Preparation compares manager, phone, and rail with that burst. Stored `transport_from_number` is not independently authenticated by SQL, but it is not passed to the actual Claw send helper as a sender override; the runtime transport supplies its identity. The high-level Claw enqueue path overwrites it from the server's shared-line resolver. Twilio still obtains its sender from registered manager-number state. No client-supplied sender exploit was established.
- Durable gateway enqueue failures now release the local seen-message claim (`src/lib/claw-leasing-bot.server.ts:1054`). Targeted handler tests passed for same-process retry and durable duplicate republication.
- The SQL/outbox states still avoid automatic requeue after the submission boundary. Expired `submitting` rows become `unknown`, and the claim flow does not revive them. SEC-2 is specifically the nested transport retry beneath that boundary.
- Consent is checked before subsequent database calls and Claw route registration, not atomically with provider submission. A STOP in the remaining interval is still a last-check-to-send race. Do not label the burst revision fence as atomic STOP enforcement.
- No authoritative manager-takeover state was identified. `agent_sessions.status = escalated` is notification state, not demonstrated manager control. Takeover acceptance remains unverified; no takeover bypass is asserted.
- Claw is explicitly retired in the authoritative SMS notes. Its unconditional configuration rejection is an implementation/planning conflict, not something credentials alone can repair. Consolidated Astra review must resolve this before claiming dual-ingress acceptance.
- No live QStash callback/recovery cycle, provider delivery, designated-recipient SMS QA, paid shadow execution, shared staging migration/preview QA, or deployment was performed by this reviewer. Full QA results remain owned by the root and implementation handoff.

## Reviewer validation

- `npx vitest run tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts`: **exit 0, 3 files, 11 tests passed**.
- Actual Claw helper / thrown suppression probe: **exit 0, 7 assertions**, synthetic key and in-memory WebSocket, no network.
- Actual consent module / new gate infrastructure-error comparison: **exit 0, 4 assertions**, database stub, no network.
- Retained combined reproduction: `node /tmp/prospect-sms-security-correction1.RxOw5A/probe.cjs` from the repository root, **exit 0, 11 assertions**. This temporary local artifact contains both probes and imports the reviewed source; it will need updating once correction cycle 2 intentionally removes the Claw linkage/gate.
- Independently checked HEAD and final migration hash. Full unit/lint/typecheck/build and the 78 real SQL assertions are not relabeled as this reviewer's executions.
