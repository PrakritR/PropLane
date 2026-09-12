# Prospect SMS correction cycle 1 - fresh Astra review

Date: 2026-09-12. Branch `prospect-agent-eval-loop`, HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. Verdict: **changes required; no activation/readiness approval**. Root resolved the gateway scope conflict after the initial findings in `prospect-sms-retired-transport-amendment.md`: keep Claw retired, remove its new managed linkage, and complete the active manager-owned Twilio deliverable.

This review inspected the actual corrected callback, durable SQL, dispatcher, transport helper, leasing handler/runtime, escalation tool, shadow runner/comparison/recovery, and behavioral tests. It preserves the pre-existing dirty-tree boundary in the original handoff. No implementation, shared database, messaging, paid model, git state, or release mutation was performed. This report, the correction review report, and correction2 plan are the review artifacts.

## Findings

### R1 / P1: C2's supported gateway claim is incompatible with the actual runtime

`src/lib/claw-messenger.server.ts:35` hardcodes `isClawMessengerConfigured()` to false. The real gateway webhook rejects before receipt processing at `src/app/api/webhooks/claw-messenger/route.ts:54`; both the new durable transport and dispatcher also consult the same function. Supplying credentials cannot make this path work. This implements the authoritative retirement invariant at `docs/agents/sms-system.md:895`, which says environment flags cannot reactivate the shared line.

The new dispatch tests replace that function with true and replace the real sender, so they establish conditional routing propagation, not the approved real gateway delivery acceptance. The handoff's description of supported Claw dispatch and activation is inaccurate without resolving this material plan conflict. The orchestrator must reconcile the approved dual-ingress requirement with retirement using the user's actual session authority. Implementation must not silently reactivate the historical rail or silently claim a reduced scope complete.

Moreover, if that rail is made reachable, `src/lib/sms/owner-sms-dispatcher.server.ts:605` delegates to the historical `sendClawMessengerText`, which retries ambiguous timeout/WebSocket outcomes with a fresh message ID at `src/lib/claw-messenger.server.ts:231` and `:261`. A durable outbox's single helper call can therefore submit two provider frames. The parallel security reviewer reproduced this against actual transpiled source with a local socket stub. This is a latent defect in the new managed path, not a presently reachable duplicate send while retirement remains enforced. The same reviewer confirmed the new Claw consent gate fails open on database lookup errors; see the correction security report.

### R2 / P2: C5 comparison identity and grounding remain disconnected from real primary execution

`src/lib/agent/leasing-sms-agent.server.ts:392` supplies only existing actor metadata plus channel to the primary trace. Its prompt hash/release are passed correctly, but burst ID/revision are still absent despite the correction's requirement to stamp both paired traces.

The real snapshot at `src/lib/agent/leasing-sms-agent.server.ts:511` supplies only `primaryEvidence.toolCalls`. `compareProspectShadow` at `src/lib/agent/prospect-shadow-comparison.ts:88` immediately returns grounding `unknown` unless `supportedFacts` exists. No runtime producer supplies those facts and no scorer derives them from the recorded tool outputs. Thus every real recovered job has unknown grounding even when its sealed evidence supports a deterministic check. The passing scorer test manually supplies a richer shape than the runtime ever produces.

The correction did improve serialized identity, incumbent-output separation, empty-output unknown behavior, actual replay detection, and conservative repetition. Those are useful and should remain. Complete the narrow evidence wiring and test the real snapshot producer through serialization/recovery; do not solve this by assuming a model's own answer is factual evidence.

### R3 / P2: requested incident integration coverage is still absent

`tests/unit/prospect-sms-burst-callback.test.ts:106` returns a prewritten successful result from a fully mocked leasing handler. At `:136`, `:142`, and `:145`, silence, resend, and correction are likewise chosen by the test's mock. Those assertions prove callback forwarding and branching, not that the real agent receives canonical Jain Home context, calls scoped tour tools, suppresses a delivered repeat without fallback, or fences a pending generation after correction.

Existing pure helper, tool, loop, and SQL tests provide valuable component coverage, but no test located here invokes `runLeasingSmsAgentTurn` for these incident sequences. Add a bounded hermetic runtime test retaining the real handler/agent/tool boundary and stubbing the provider plus nonproduction persistence. At least one realistic correction should arrive while a provider response is pending. This is required by correction cycle 1's acceptance section, not a request for live paid model execution.

## Corrections accepted in this snapshot

- **C1:** Atomic `prepare_prospect_sms_delivery` creates the intent and prepares its burst under one transaction. Prepare/submit take burst then outbox locks; stale and terminal intents are not revived. Root independently applied/reapplied the same migration hash and ran 78 real SQL assertions, including visibility, rollback/reclaim, constraints, concurrency, terminal non-revival, rail tampering, and client-role denial. No remaining C1 blocker was found in this review.
- **C2 mechanics:** Persisted latest-ingress rail/catalog state and server-side callback propagation address the original lost routing metadata. They do not remove R1.
- **C3:** The handler now releases process-local receipt claims on durable enqueue failure; duplicate durable ingress republishes without changing the SQL deadline. The same-process handler test exercises retry after mocked enqueue failure, and SQL/publication tests cover the persistence side. No further concrete C3 blocker was established.
- **C4:** Suppressed notification results persist as suppressed, do not mark the session escalated, and cannot yield delivered/already-notified on retry. Unknown outcomes retain their dedupe claim. No remaining C4 blocker was found.
- **C5 isolation:** The frozen shadow has no live handlers, separates incumbent output from model input, preserves exact matching tool replay, and persists explicit unknown output. R2 concerns the missing runtime evidence/trace connection.

## Evidence and limits

- Independently checked HEAD and migration SHA-256 `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`.
- Read the actual code and tests, rather than treating handoff claims as proof. The graph query completed with exit 0 but used the legacy `graphify-out` graph; current source was authoritative. Graph refresh/portable-check remain blocked by the documented tooling mismatch.
- Root's isolated SQL result is 78 assertions, exit 0, with clean and repeat apply exit 0. See `prospect-sms-db-probe.md`; this reviewer did not relabel root's commands as independently executed.
- Sol reports the final focused 12-file/101-test suite and the 4 GB typecheck exited 0. Lint, full unit, build, lockfile, and bounded browser evidence were still being finalized when these findings were written. Consult the correction handoff for final command results; broad green checks cannot close R1-R3 by themselves.
- Security sibling ran local no-network probes for the real Claw sender retry and consent fail-open behavior; its report owns exact commands and counts.
- No authoritative manager takeover state exists in the inspected prospect runtime. Notification escalation is not proof of takeover. That acceptance remains explicitly unmet; no new takeover architecture is proposed here.
- No real QStash callback, designated-recipient SMS, paid GPT call, deployed migration, or staging QA was performed. Browser sign-in evidence does not establish these external paths.

Next: `prospect-sms-single-reply-correction2.md`, governed by `prospect-sms-retired-transport-amendment.md`. The root decision closes the planning ambiguity in R1; removal of the new unsafe/unreachable managed linkage and accurate activation guidance remain required implementation work. Security evidence is in `docs/security/2026-09-12-prospect-sms-security-correction1-review.md`. One automated correction cycle remains under the repository workflow.
