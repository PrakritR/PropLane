# Prospect SMS correction cycle 1 handoff

## Fresh review outcome

Changes remain required. The next correction is specified in
`docs/plans/prospect-sms-retired-transport-amendment.md`. Fresh review found
that this cycle's managed Claw support conflicts with the authoritative SMS
contract that unconditionally retires Claw. The next cycle must preserve that
retirement and keep the durable path on active Twilio. It also must complete
C5 runtime factual evidence and primary trace identity and replace remaining
mock-composed incident checks with actual handler/agent/provider-stub coverage.
The implementation notes below describe the reviewed cycle-1 state and are not
an approval of its Claw architecture.

## Goal and source

- Original plan: `docs/plans/prospect-sms-single-reply.md`
- Correction plan: `docs/plans/prospect-sms-single-reply-correction.md`
- Branch: `prospect-agent-eval-loop`
- Starting/current commit: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`; correction remains intentionally uncommitted for fresh Astra review.
- Priority: prevent duplicate prospect replies on the supported manager-owned Twilio rail while preserving sender identity and conservative evaluation evidence. The historical Claw/shared-line rail remains retired.

## Corrected behavior

- C1: `prepare_prospect_sms_delivery` is one service-only transaction that locks the current burst lease, validates its trusted manager/recipient/rail, inserts the unique outbox intent, and transitions the burst to `prepared`. There is no visible claimable row before attachment. A rollback or worker crash leaves neither row; the next worker can retry. Submitted, unknown, blocked, stale, or mismatched rows are never adopted. Prepare and submit use the same burst-then-outbox lock order.
- C2: ingress persists the supported Twilio rail and manager-owned sender identity. Retired Claw/shared-line ingress is rejected before durable acceptance, and persisted retired-rail rows are blocked before any provider call or Twilio fallback. Manager, recipient, transport, and sender inputs are derived inside trusted server flow and fenced again in SQL.
- C2 consent/runtime: active Twilio dispatch retains the existing unreadable-consent deferral and terminal unknown submission boundary. The retired Claw rail has no activation or provider fallback path.
- C3: a supported Twilio receipt retries after durable enqueue/config/publication failure because the warm-process receipt claim is released. A duplicate database receipt republishes its existing burst/revision without creating a second ingress or resetting the quiet window. Retired gateway ingress is rejected and does not enter this retry path.
- C4: `notifyManagerFromAgent({delivered:false,suppressed:true})` is stored as `deliveryStatus: suppressed`, does not mark the session escalated, and remains suppressed on a deduplicated retry. Unknown delivery remains terminal/unknown; explicit thrown failure retains the existing safe retry path.
- C5: the frozen shadow snapshot now includes burst revision, primary prompt hash/release, provider/model, primary output, primary tool-call evidence, and explicit repetition/correction evidence. Primary output is comparison-only and never enters GPT input. Recovery persists the complete comparison result, with explicit unknown grounding/repetition/tool values when evidence or output is incomplete, and emits the paired identity on the shadow trace. Empty model output is unknown. Tool correctness becomes replayed only after an actual matching model tool call. Conservative rules keep paraphrases and unsupported prose unknown, mark unsupported numeric facts ungrounded, and distinguish requested resends from accidental exact repeats.
- Incident regressions cover active Twilio durable ingress/dispatch and explicit retired-Claw rejection before handler/provider execution, plus redundant silence versus explicit resend/correction and publication retry after a durable duplicate receipt.

There is no authoritative manager-takeover state in the current prospect runtime. `agent_sessions.status = escalated` records notification state and is not evidence that a manager has taken control. This correction deliberately does not invent a new takeover architecture; that acceptance item remains a product/architecture follow-up.

## Files changed for correction cycle 1

- `supabase/migrations/20260912143000_prospect_sms_bursts.sql`
- `src/app/api/internal/prospect-sms-burst/route.ts`
- `src/lib/sms/owner-sms-dispatcher.server.ts`
- `src/lib/sms/prospect-sms-burst.server.ts`
- `src/lib/proplane-sms-transport.server.ts`
- `src/lib/claw-leasing-bot.server.ts`
- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/agent/prospect-gpt-shadow.ts`
- `src/lib/agent/prospect-shadow-comparison.ts`
- `src/lib/tools/domains/leasing-sms.ts`
- `tests/unit/prospect-sms-outbox-dispatch.test.ts`
- `tests/unit/prospect-sms-burst-callback.test.ts`
- `tests/unit/prospect-sms-shadow-recovery.test.ts`
- `tests/unit/prospect-sms-ingress-retry.test.ts`
- `tests/unit/claw-resident-inbound-logging.test.ts`
- `tests/unit/agent/openai-shadow-provider.test.ts`
- `tests/unit/agent/prospect-shadow-comparison.test.ts`
- `tests/unit/leasing-sms-escalation.test.ts`

The broad dirty-tree boundary from `docs/plans/prospect-sms-single-reply-handoff.md` still applies. Do not stage the whole tree. This correction imports no pre-existing untracked evaluation scripts.

## Database evidence

- Final corrected migration SHA-256: `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`.
- Root independently applied and reapplied the migration against isolated PostgreSQL with actual baseline `sms_outbox` and `sms_delivery_attempts` DDL: exit 0.
- The revised original 52 checks plus 26 correction checks passed: 78 assertions, exit 0. They include transaction visibility/rollback, crash retry, concurrent same-intent prepare, prepare-versus-submit lock ordering, stale/new ingress, non-UUID canonical property IDs, mixed rail policy, manager/phone/rail tamper rejection, terminal submitted/unknown non-revival, and anon/authenticated denial.
- Exact commands, fixtures, hash, and limits are in `docs/plans/prospect-sms-db-probe.md`. No shared database was changed.

## Validation evidence

- Integrated focused correction suite: 10 files / 81 tests, exit 0 before the final conservative shadow assertions; the final focused rerun is recorded below.
- Existing transport consent suites: 2 files / 19 tests, exit 0.
- Targeted correction ESLint: exit 0 before the final shared-gate/scorer edits; final lint is recorded below.
- Default-heap `npx tsc --noEmit --pretty false`: exit 134, Node heap exhausted near 2 GB. This is an environment/resource result, not a type diagnostic. A 4 GB rerun is recorded below.

Final validation in progress:

- Focused correction + existing transport consent suite: `npx vitest run` over 12 files, 101 tests passed, exit 0.
- First 4 GB typecheck found three stale optional burst references in the now non-prospect insert branch, exit 2. They were removed. `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false` then passed, exit 0.
- `npm run lint`: exit 0, 0 errors and 1,001 existing repository warnings.
- `npm run test:unit`: 1,332 files / 9,150 tests passed, exit 0.
- `NODE_OPTIONS=--max-old-space-size=4096 npm run build`: not rerun after fresh review required correction cycle 2; the pre-correction baseline 4 GB build was exit 0.
- `npm run lockfile:verify`: not rerun after correction because no correction-cycle package edits were made; the pre-correction QStash-only lock verification was exit 0.
- `git diff --check`: pending final rerun.

## Activation, QA, and external limits

- Durable prospect delivery is supported only on manager-owned Twilio ingress. `PROSPECT_SMS_BURSTS_ENABLED=1` does not activate the historical Claw gateway; its legacy debounce remains historical, and Claw webhook ingress is rejected by the retirement guard.
- Rollback remains `PROSPECT_SMS_BURSTS_ENABLED=0` for supported Twilio ingress; already-prepared durable rows defer. The retired Claw ingress remains rejected regardless of the durable flag.
- Root's initial browser evidence is in `docs/plans/prospect-sms-browser-qa.md`: dev/test manager sign-in passed; the SMS route redirected to the active communication surface as expected while the UI flag is off. Cold dev compilation caused portal/tour timeouts and the task server was stopped. Root will rerun a bounded check after the final build. No SMS was sent.
- Graph refresh is blocked by local tooling mismatch: PATH has legacy Python `graphifyy` without `hook-rebuild` or `portable-check`, `npx graphify` has no executable, and there is no TypeScript runtime artifact. Existing `.graphify` was not downgraded or rewritten.
- No QStash credentials, designated SMS test recipient, or approved development OpenAI key were supplied. No managed callback, live SMS/Claw send, paid shadow call, staging migration, production/staging write, release, PR, Linear action, or no-mistakes run occurred.

## Fresh Astra review continuation prompt

Read `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, `docs/agents/akhil-feature-cycle.md`, `docs/agents/sms-system.md`, `docs/ai-assistant.md`, `docs/plans/prospect-sms-single-reply.md`, `docs/plans/prospect-sms-single-reply-correction.md`, `docs/plans/prospect-sms-single-reply-review.md`, both `docs/security/2026-09-12-prospect-sms-*.md` reports, `docs/plans/prospect-sms-db-probe.md`, `docs/plans/prospect-sms-browser-qa.md`, and this handoff. Freshly review the uncommitted correction-scope diff on branch `prospect-agent-eval-loop` from HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, preserving the documented pre-existing dirty boundary. Verify C1 atomic visibility/crash recovery/lock ordering/terminal non-revival, C2 supported Twilio rail and explicit retired-Claw rejection before handler/provider execution, C3 same-process and post-persistence publication retry, C4 suppressed-versus-delivered escalation state, and C5 sealed paired comparison identity/evidence/unknown semantics. Re-run risk-based checks and inspect final broad validation appended here. Treat manager takeover as explicitly unsupported absent an authoritative state. Do not write shared databases, send messages, use inherited paid keys, release, commit, open a PR/Linear ticket, or run no-mistakes. If findings remain, report them to Akhil; no additional automated correction is available.
