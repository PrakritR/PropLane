# Prospect SMS correction cycle 2 handoff

## Goal and governing scope

- Original plan: `docs/plans/prospect-sms-single-reply.md`
- Final correction: `docs/plans/prospect-sms-single-reply-correction2.md`
- Governing transport amendment: `docs/plans/prospect-sms-retired-transport-amendment.md`
- Branch: `prospect-agent-eval-loop`
- Starting/current HEAD: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`; the reviewed work remains uncommitted in the documented dirty tree.
- Supported durable scope: manager-owned Twilio prospect SMS only. The shared Claw transport remains deliberately retired.

## Final correction behavior

### D1: retired transport is unreachable from the new durable path

- `enqueueProspectSmsBurst` rejects `channel: "claw"` before health checks, database writes, or QStash publication.
- The historical shared-line handler rejects unsupported ingress before durable acceptance. The process-local receipt claim is released, but a retry remains an explicit retired result and cannot create a burst.
- The signed callback rejects a persisted `reply_transport = claw` row before invoking the leasing handler.
- The outbox enqueue and dispatch boundaries reject or block persisted Claw rows as `retired_transport_unsupported`. They do not invoke Claw, do not invoke Twilio, and do not fall back to a manager sender.
- `sendPropLaneSms` rejects a durable Claw candidate before the legacy consent lookup or any provider call. Historical unreachable Claw helpers and their retirement guards remain otherwise unchanged. The new durable path cannot reach the historical provider helper that retries uncertain frames.
- Active Twilio dispatch retains fail-closed unreadable-consent deferral and the terminal `unknown` state after an uncertain provider submission.
- The temporary gateway debounce activation and new shared consent helper from correction cycle 1 were removed. Original and correction-cycle-1 handoff guidance now describes Twilio-only durable activation.

### D2: paired trace identity and conservative real evidence

- The primary leasing trace carries `burstId` and `burstRevision` together with the existing prompt ID/hash/release metadata.
- The serializable shadow snapshot retains that paired identity, provider/model, frozen pre-turn conversation, schemas, exact typed tool evidence, repetition inputs, and incumbent output for comparison only.
- The runtime projects only successful `get_listing_details` and `list_open_tour_slots` results into checkable facts. Each fact group is bound to one canonical property. Missing, failed, ambiguous, or unrelated listing evidence stays unknown and cannot be combined into a cross-property bag of facts.
- GPT's first request receives the same pre-turn conversation, system prompt, and tool schemas, without the incumbent answer or current-turn tool outputs. A current-turn tool result is replayed only after GPT requests the exact recorded tool name and canonical arguments.
- Recovery persists and traces burst ID/revision plus prompt ID/hash/release for completed and explicit-unknown comparisons. Empty output and missing evidence remain unknown.

### D3: actual runtime incident boundary

`tests/unit/agent/prospect-sms-runtime-boundary.test.ts` retains the real `runLeasingSmsAgentTurn`, agent loop, registry, schemas, and typed tools while replacing provider, persistence, notification, and transport boundaries.

It covers:

- joined/spaced JainHome fragments resolving through `get_listing_details` to the fixture's canonical `property-jain-home` ID;
- JSON serialization followed by the real isolated shadow runner, paired identity, property-bound grounding, first-request fairness, and exact sealed tool replay;
- a provider completion held pending while the active revision advances, with the old revision's `request_tour` authorization and candidate delivery rejected, no tour inquiry created, and the next real loop receiving the merged correction;
- typed silence tied to a confirmed recent reply, while an explicit resend and explicit property correction remain eligible for a reply;
- the real typed `list_open_tour_slots` call with the same canonical property ID, including resolved zero-slot and lookup-error outcomes;
- approval-first tour behavior: the stale inline write cannot create a tour inquiry or book anything.

No authoritative manager takeover state exists in this runtime. `agent_sessions.status = escalated` is notification state, not evidence of manager control. This cycle does not invent a takeover mechanism.

## Correction-cycle-2 files

- `src/app/api/internal/prospect-sms-burst/route.ts`
- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/agent/prospect-gpt-shadow.ts`
- `src/lib/agent/prospect-shadow-comparison.ts`
- `src/lib/claw-leasing-bot.server.ts`
- `src/lib/proplane-sms-transport.server.ts`
- `src/lib/sms/owner-sms-dispatcher.server.ts`
- `src/lib/sms/prospect-sms-burst.server.ts`
- `tests/unit/agent/prospect-sms-runtime-boundary.test.ts`
- `tests/unit/proplane-transport-consent-gate.test.ts`
- `tests/unit/prospect-sms-burst-callback.test.ts`
- `tests/unit/prospect-sms-ingress-retry.test.ts`
- `tests/unit/prospect-sms-outbox-dispatch.test.ts`
- `tests/unit/prospect-sms-shadow-recovery.test.ts`
- `tests/unit/claw-resident-inbound-logging.test.ts`
- `docs/plans/prospect-sms-single-reply-handoff.md`
- `docs/plans/prospect-sms-single-reply-correction-handoff.md`
- this handoff

The original dirty-tree boundary in `docs/plans/prospect-sms-single-reply-handoff.md` still applies. Do not stage the whole repository. No runtime imports were added to the pre-existing untracked evaluation scripts.

## Database and real-data evidence

- The migration is unchanged from correction cycle 1. SHA-256 remains `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`.
- Root's isolated PostgreSQL evidence remains clean apply exit 0, repeat apply exit 0, and 78 concurrency/security/state assertions exit 0. Exact evidence is in `docs/plans/prospect-sms-db-probe.md`. No shared database was changed.
- Root ran read-only typed-tool checks against dev/test. `list_live_listings` resolved both `FirLofts` and `Fir Lofts` as one exact result with canonical ID `mgr-test-fir`, exit 0. `listOpenTourSlots({ propertyId: "mgr-test-fir" })` returned resolved with 106 open slot keys; a deliberately missing ID returned unavailable with zero slots, exit 0. No model, write, or SMS call occurred. Evidence is in `docs/plans/prospect-sms-browser-qa.md`.

## Validation

- Integrated correction suite: `npx vitest run tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/loop-suppression.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/leasing-sms-agent.test.ts tests/unit/leasing-sms-escalation.test.ts tests/unit/proplane-transport-consent-gate.test.ts tests/unit/claw-resident-inbound-logging.test.ts tests/unit/claw-manager-phones-route.test.ts`: 13 files, 88 tests passed, exit 0.
- Targeted ESLint across 15 changed source/test files: exit 0.
- `git diff --check`: exit 0.
- `shasum -a 256 supabase/migrations/20260912143000_prospect_sms_bursts.sql`: unchanged expected hash.
- `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`: exit 0.
- `npm run lint`: exit 0 with 0 errors and 1,001 existing repository warnings.
- `npm run test:unit`: exit 0, 1,333 files and 9,157 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 npm run build`: exit 0; TypeScript completed and all 387 static pages generated.
- `npm run lockfile:verify`: exit 0 (`package-lock.json verified (npm ci OK)`). It reported the expected local Node 24/npm 11 engine warning while CI is pinned to Node 22/npm 10, plus existing dependency deprecation/audit notices.

## External and tooling limits

- No QStash credentials are present, so no real managed publish/callback/recovery cycle was run.
- No designated development OpenAI key was supplied. The inherited key was not used, and no paid shadow call was made.
- No designated SMS recipient was supplied. No Twilio or Claw message was sent.
- No shared dev/staging/production schema write, production data write, release, PR, Linear action, or no-mistakes run occurred.
- Graph refresh is blocked by the documented tooling mismatch: `npx graphify hook-rebuild` cannot determine an executable, while the available legacy Python graph is not the required TypeScript runtime. The existing graph was not downgraded or rewritten.
- Root owns the final post-build browser check and Review URL. No browser result in this handoff is claimed beyond the read-only typed-tool evidence above.

## Post-handoff final review status

- `docs/security/2026-09-12-prospect-sms-security-final-review.md` found no open security blocker for the amended manager-owned Twilio scope and verified that the retired provider helper is unreachable from the new durable path.
- `docs/security/2026-09-12-prospect-sms-bugbot-final-review.md` found one remaining P2 comparison-correctness defect: the grounding scorer groups facts by property but flattens predicate/value relationships, so `Jain Home rent is 12` can be falsely marked grounded when `12` comes from the address. This was independently reproduced against the actual projection and scorer.
- This is the second and final automated correction cycle. The P2 is reported for Akhil's explicit direction and was not changed after review. It does not reopen the verified duplicate-send, retired-transport, queue, consent, or terminal-unknown controls.

## Final review prompt

Read the root and Akhil instructions, `docs/agents/akhil-feature-cycle.md`, `docs/agents/sms-system.md`, `docs/ai-assistant.md`, the original plan, both correction plans and reviews, `docs/plans/prospect-sms-retired-transport-amendment.md`, the dated prospect SMS security/bugbot reports, the SQL/browser evidence, and this handoff. Review the plan-scoped dirty diff from HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. Verify D1 zero-call retired-rail rejection and preserved active Twilio consent/unknown behavior; D2 paired identity, property-bound factual projection, sealed replay fairness, no incumbent leakage, and explicit unknowns; D3 real runtime correction fencing, suppression/resend/correction, canonical tour tool use, and approval-first writes. Attribute root SQL/real-data evidence accurately. This is the final automated correction cycle, so report remaining findings rather than creating another correction cycle. Do not write shared databases, send messages, use inherited paid keys, release, commit, open a PR/Linear ticket, or run no-mistakes.
