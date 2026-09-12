# Prospect SMS correction cycle 1

Fresh Astra review, 2026-09-12. Starting/current HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, branch `prospect-agent-eval-loop`. Preserve the dirty-tree boundary in the execution handoff. No release, production/staging writes, live messaging, inherited OpenAI key, PR, Linear, or no-mistakes authorization.

## Required corrections

### C1 / P1: make outbox publication and preparation one recoverable transition

`src/lib/sms/owner-sms-dispatcher.server.ts:226` inserts an immediately claimable row before calling prepare at line 255. `supabase/migrations/20260912143000_prospect_sms_bursts.sql:202` allows prepare on any correlated outbox status. A competing outbox cron sees a generating burst and blocks its row as stale; prepare subsequently succeeds and strands `prepared/blocked` forever. Root independently reproduced this with actual isolated PostgreSQL: `premature_cron_begin='stale'`, `prepare_after_cron=true`, resulting state `prepared/blocked`.

A related process crash is also unrecoverable: worker A inserts, dies before prepare, and worker B reclaims the same revision. The unique burst/revision row retains A's worker ID, so B's prepare fails at the correlation predicate. The generic fallback blocks the only intent and retries cannot make progress.

Prefer one RPC that verifies the current generation lease, creates or adopts the unique intent, and changes the burst to prepared atomically. An explicit unclaimable preparatory state is also acceptable only with complete crash recovery. Do not label transient persistence errors or the pre-prepare window as irreversible stale work. Never adopt a submitted/unknown/terminal row for resubmission. Preserve budget linearization and revision fencing.

Required real-SQL and dispatcher tests: cron interleaves immediately after insertion; process dies at that point and another worker reclaims; prepare RPC errors transiently; new ingress before preparation; submitted/unknown replay. Establish eventual one intent and at most one provider submission, with no prepared/blocked orphan.

### C2 / P1: preserve the approved gateway transport and catalog semantics

`src/app/api/internal/prospect-sms-burst/route.ts:74` always passes `managerUserId`, while `handleClawLeasingInbound` derives `crossCatalog` from its absence (`src/lib/claw-leasing-bot.server.ts:1073`). The original shared Claw line searches all managers' public listings; every queued replay becomes manager-scoped. The stored burst `channel` is only `sms` and cannot recover ingress transport/catalog scope. Also `src/lib/proplane-sms-transport.server.ts:158` rejects every durable burst under Claw-primary, so enabled queue traffic can never reply on that configured rail. The existing gateway webhook explicitly requires replies from the shared Claw number to remain in the sender's thread.

Persist server-derived routing/catalog/transport information needed by the worker. Keep trusted owner identity separate from whether the public catalog is shared. Implement at-most-once managed durable dispatch for the supported gateway rail without silently moving the reply to a different number or losing cross-catalog behavior. If the architecture intentionally requires retiring a rail, report a planning blocker and reconcile with the approved dual-ingress requirement; do not claim this is merely a missing credential.

Required tests: Claw-primary receipt through queue to its original reply transport; shared-line follow-up naming another manager's public listing; Twilio remains owner-scoped; ingress transport and sender identity cannot be client-overridden. Cover a mixed Twilio/gateway burst with an explicit deterministic reply-rail policy.

### C3 / P1: never acknowledge a nondurable gateway receipt from process memory

`src/lib/claw-leasing-bot.server.ts:714` records the source in an hour-long process-local seen map. Queue/config/ingress failure at line 1051 returns without releasing that claim. Gateway retries do not pass `durablyClaimed`; the next retry immediately returns success before attempting durable ingress again. With missing signing config or an ingress RPC error, no burst exists for cron recovery and the prospect's input is lost.

Release the local claim on every durable enqueue failure, or bypass this shortcut for durable prospect ingestion and use the database receipt as the authority. Duplicate persisted input must still retry failed publication without resetting the quiet window.

Required behavioral test through the actual handler/webhook: fail health before persistence, retry the same message in the same process, restore config, and assert one durable receipt plus a publish attempt. Separately fail publication after persistence and assert retry republishes without a second receipt or due-time reset.

### C4 / P2: do not turn a suppressed notification into delivery success

`src/lib/tools/domains/leasing-sms.ts:658` discards the return from `notifyManagerFromAgent`. That helper legitimately returns `{delivered:false,suppressed:true}` when the manager disables its channels. The tool writes `deliveryStatus:'delivered'` at line 684 anyway, reports the manager notified, and later returns `alreadyEscalated` success. Check the actual delivery result and represent a disabled/suppressed outcome honestly. Preserve unknown-delivery idempotency; do not clear claims and blindly resend uncertain notifications.

Required test: all manager notification channels disabled, then retry within the dedupe bucket. Neither call may report delivered/already notified or create a delivered audit result. Retain existing failed-then-retry and concurrent-claim tests.

### C5 / P2: complete the promised shadow comparison record

`runProspectGptShadow` returns only reply/model/usage/latency for successful work (`src/lib/agent/prospect-gpt-shadow.ts:129`). The durable worker deliberately removes `onResult`, then persists/traces only that reduced result (`src/lib/sms/prospect-sms-burst.server.ts:155`, `:175`). Prompt hash/release, burst revision, grounding, repetition and tool-correctness comparison evidence are absent. Merely declaring optional fields in an unused callback type does not create paired comparison metadata. There is no incumbent comparison payload available to a scorer separate from the shadow model's pre-turn input, and empty model output can be marked completed.

Persist primary output/evidence and prompt/version metadata alongside the frozen shadow input, but keep incumbent output out of the shadow model input. Return durable comparison metadata with explicit unknown values when evidence is incomplete, and score deterministic grounding/repetition/tool behavior where evidence supports it. Reuse the approved sealed evaluation machinery rather than inventing unrelated scorer semantics. Include burst revision and prompt/release identity on both paired traces. Treat empty shadow response as unknown. Do not mark tool correctness replayed merely because a nonempty schema list was supplied. Preserve zero live handlers and bounded, nonblocking execution.

Required tests: serialized snapshot followed by recovery retains comparison identity/results; absent evidence remains unknown; empty output is unknown; known repetition/correction fixtures produce the intended deterministic evidence; no live database/tool/notification calls are reachable by the shadow. Incomplete baseline evidence must remain incapable of passing comparison.

## Acceptance and validation

Add the missing end-to-end incident fixtures at the handler/worker/provider-stub layer: the two-message JainHome burst, a correction while generation is pending, redundant question versus explicit repeat/correction, and canonical-property tour follow-up. Existing tests establish mechanics but do not prove these full paths. Clarify and test the authoritative manager takeover behavior if such a supported state exists; otherwise document the unmet acceptance explicitly rather than inventing a state.

Reapply the final migration on clean isolated PostgreSQL and repeat it, run the new interleavings, targeted behavioral tests, typecheck, lint, full unit/build checks as required, and refresh graphify with portability validation. Append exact exit codes and seeded browser QA to a correction handoff. QStash configuration, designated SMS recipient, approved development OpenAI key, and staging release authorization remain external limitations, not substitutes for these local fixes. Fresh Astra review is required after the integrated correction.
