# Prospect SMS correction cycle 2

Fresh Astra review, 2026-09-12. Branch `prospect-agent-eval-loop`, HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. This is the final permitted automated correction cycle. Preserve the original dirty-tree scope and all shared database, messaging, release, and paid-key restrictions.

## Governing planning amendment: Claw stays retired

The approved original plan requires both direct Twilio and gateway ingress on their original rails. The authoritative SMS notes at `docs/agents/sms-system.md:895` retire Claw, and `isClawMessengerConfigured()` literally returns false. Actual gateway POST always returns 503. The cycle1 handoff incorrectly treats the path as supported and activatable by configuration.

Root Astra resolved this mismatch in `docs/plans/prospect-sms-retired-transport-amendment.md`, which governs this correction. Claw stays retired; the final supported scope is the active manager-owned Twilio path. Akhil's original SMS request did not authorize or require reactivating the shared number. Follow the amendment and remove misleading managed-Claw support/activation claims. Do not change the retirement guard or public sender behavior.

## D1 / P1: remove managed linkage to the retired rail and reject it explicitly

The new outbox calls the real historical sender, which submits a second frame after timeout/close with a fresh correlation ID. A single outbox invocation is insufficient. Remove that new managed provider branch and reject unsupported/retired ingress before accepting durable work. At dispatch, unsupported persisted rows must make zero provider calls and must never fall back to a manager's Twilio number. Preserve the active Twilio no-retry/terminal-unknown boundary. Historical retired helpers may remain unchanged outside the new path; fixing or reactivating them is not this task.

The newly wired managed-Claw consent helper also inherits a fail-open lookup: returned Supabase errors are ignored by `isPhoneOptedOut`. Remove that new managed bypass with the Claw branch. Keep the active managed Twilio suppression policy, where unreadable and clear are distinct and unreadable defers without sending. Avoid broad changes to unrelated historical sends.

Required no-network tests exercise the real retirement guard with configuration variables present, unsupported enqueue, and persisted retired-rail dispatch. Assert no managed Claw call, no Twilio fallback, and an explicit unsupported outcome. Preserve/test active Twilio uncertain submission as terminal unknown and an unreadable managed suppression ledger as no-send/deferred. Replace conditional mocked-Claw-success tests. Keep compatibility SQL metadata if harmless; do not add archival tables/workflows or disturb the proven C1 migration solely to remove a historical label.

## D2 / P2: wire real shadow snapshot evidence and paired trace identity

At `src/lib/agent/leasing-sms-agent.server.ts:392`, include the current burst ID/revision in primary trace metadata, alongside existing prompt metadata. Persist those same values in the snapshot and shadow trace.

At `:511`, the runtime supplies only tool calls; the scorer requires `supportedFacts` at `src/lib/agent/prospect-shadow-comparison.ts:88`. Add a conservative, typed projection from sealed successful tool evidence into deterministic checkable facts, or consume the recorded outputs directly through the approved evaluation mechanism. Keep absent/ambiguous evidence unknown. Do not infer facts from incumbent prose or treat membership in a bag of unrelated listing values as proof of a factual relation. Keep incumbent output out of GPT input and retain the existing handler isolation, bounds, and empty-output unknown rule.

Required test: invoke the actual leasing runtime with a deterministic provider and known Jain Home/listing/tour fixture outputs; JSON serialize its returned shadow snapshot; recover it through the real runner; assert matching primary/shadow identity and supported deterministic evidence, while missing evidence and unsupported facts remain unknown/failed appropriately. Include actual primary trace metadata assertions. Manually constructing a richer snapshot than the runtime emits does not close this finding.

## D3 / P2: complete the incident behavioral boundary

Add a bounded integration-style unit fixture using the actual leasing handler/runtime and typed tools, with provider, clock, and persistence boundaries stubbed. Cover:

1. Two joined/spaced JainHome fragments produce one burst answer and use the fixture's canonical text property ID.
2. A new correction arrives while the first provider response is pending; its candidate and inline action cannot submit after the revision changes, and the next turn sees the complete corrected input.
3. A confirmed recent answer can yield typed silence with no fallback/outbox. Explicit resend and a property correction remain eligible to answer.
4. A canonical-property follow-up reaches `listOpenTourSlots` through the proper typed tool with the same public property ID, distinguishes no slots from lookup failure, and preserves approval-first writes.

Retain the existing SQL concurrency suite and pure tests. Do not replace them with source matching. The new callback tests that stub the entire handler are useful routing tests but are not evidence of these behaviors.

## Integration and validation

Keep the cycle1 atomic SQL unless a new concrete issue requires changing it. If SQL changes, root reruns clean/repeat apply and the 78-check probe on the new hash. Run focused real-boundary tests, normal typecheck/lint/unit/build checks as appropriate, and update the durable handoff with exact commands, exit codes, source scope, and test limitations. Reuse final validation only if its snapshot still matches. Preserve graphify and browser limitations honestly; do not claim a refresh or real messaging QA without evidence.

Fresh Astra and security review are required after correction. Apply the root transport amendment throughout the handoffs and activation guidance; the rail is retired, not merely missing credentials. No additional automated correction after cycle2; report remaining findings to Akhil.
