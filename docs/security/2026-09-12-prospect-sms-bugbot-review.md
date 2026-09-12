# Prospect SMS bugbot review

Fresh Astra review, 2026-09-12. Reviewed plan-scoped uncommitted changes on `prospect-agent-eval-loop` at HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. This is normal independent review, not no-mistakes. Existing process/evaluation work was preserved; no implementation, database, release, or messaging mutation was performed by this reviewer.

## Findings

1. **P1: outbox preparation race and process crash can permanently lose a reply.** `src/lib/sms/owner-sms-dispatcher.server.ts:226` publishes a claimable row before preparation; `supabase/migrations/20260912143000_prospect_sms_bursts.sql:202` does not require a sendable status. A competing cron blocks it, then prepare succeeds and leaves an unrecoverable prepared/blocked pair. Root reproduced the real SQL interleaving. Reclaimed workers also cannot adopt a pre-prepare row because it retains the prior worker ID. See C1 in the correction plan.
2. **P1: enabled durable gateway traffic cannot preserve its delivery/catalog contract.** `src/lib/proplane-sms-transport.server.ts:158` rejects Claw-primary bursts; `src/app/api/internal/prospect-sms-burst/route.ts:74` forces owner-scoped catalog semantics on the shared line. Existing gateway webhook requires the Claw sender. See C2.
3. **P1: a retry can acknowledge an input that was never durably queued.** `src/lib/claw-leasing-bot.server.ts:714` puts the source in a process-local seen map; the new enqueue failure at line 1051 does not release it. Same-process gateway retry returns success before reattempting persistence. See C3.
4. **P2: suppressed escalation delivery is recorded as success.** `src/lib/tools/domains/leasing-sms.ts:658` ignores the notification helper's delivered/suppressed outcome and records delivered at line 684 even with all channels disabled. See C4.
5. **P2: persisted shadow output is not the planned comparison artifact.** `src/lib/agent/prospect-gpt-shadow.ts:129` and `src/lib/sms/prospect-sms-burst.server.ts:175` omit prompt/release/revision and comparison evidence; the callback carrying partial score fields is removed before recovery. Empty output can also complete. See C5.

Correction plan: `docs/plans/prospect-sms-single-reply-correction.md`. Independent security findings are recorded separately by the security reviewer.

## Evidence and limits

Ran `npx vitest run tests/unit/prospect-sms-burst-callback.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/loop-suppression.test.ts tests/unit/leasing-sms-escalation.test.ts tests/unit/leasing-sms-agent.test.ts tests/unit/prospect-agent-eval-scorers.test.ts`: **exit 0, 8 files, 62 tests**. Passing tests do not cover the identified interleavings and gateway failures.

Reviewed actual callback, migration, dispatcher, ingress handler, agent loop/history, listing/tour tools, escalation helper, OpenAI adapter and sealed shadow implementation. The service-only SQL privilege design, claimed-source snapshot, terminal unknown submission behavior, typed suppression, and sealed shadow handler isolation are sound directions. The isolated migration's 52 previously passing assertions remain useful but omit C1; root's new interleaving exposes it.

No live QStash, SMS recipient, or designated OpenAI key was available. Seeded browser/full validation evidence was still being finalized when this review completed. **Changes required; no full readiness approval.**
