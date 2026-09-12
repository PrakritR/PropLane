# Prospect production bugbot review

Date: 2026-09-11. Independent reviewer: prospect_prod_bugbot.

## Scope and revision

Reviewed the uncommitted prospect-conversation-production patch based on
`8ce3868b4e5775661956c6c3f36fcb146bfa931a` in pool checkout 4. Scope:
`src/lib/agent/leasing-sms-agent.server.ts`, `leasing-sms-system-prompt.ts`,
`src/lib/claw-leasing-bot.server.ts`, `src/lib/tools/domains/leasing-sms.ts`,
related SMS/AI documentation and three leasing unit suites, including the new
`leasing-sms-quiet-runtime.test.ts`. Traced the unchanged agent loop, notifier,
Twilio receipt completion and durable billing result implementation.

Read repository/Akhil instructions and feature plan. No .graphify/graph.json
exists in this checkout, so the graph impact check reported that absence and
review used the area documentation and focused source. No implementation edits,
production writes, external messages, commits, pushes or no-mistakes invocation.

## Findings resolved in correction review

### P2: Preserve a delivered quiet handoff when the final provider call fails

Initial location: `src/lib/agent/leasing-sms-agent.server.ts:290` and `:313`.
The loop observes the successful quiet escalation, then makes another model
request to produce its final text. If that request throws, the outer catch
returns null even though quietHandoffConfirmed is true. The null is persisted as
the completed paid turn and the caller sends a template. This violates the
explicit silence contract after successful manager delivery. Recover the quiet
result inside the trace callback so its effective reply remains empty, retain
observed tool evidence, and persist that terminal disposition.

Reproduced using the existing runtime fixtures: emit successful
escalate_to_manager output `{ok:true,quietHandoff:true}`, then throw a synthetic
provider error. Expected quiet disposition; actual result was null.

### P2: Do not convert durable turn-result failures into template sends

Initial location: `src/lib/claw-leasing-bot.server.ts:1167`.
The caller catches every runLeasingSmsAgentTurn rejection and continues to a
template. completeCommsTurn and readCommsTurnResult deliberately throw when
saving or replaying a paid result requires retry. A quiet notification may
already have succeeded, but its save failure becomes a template send and the
Twilio route completes the inbound receipt. This catch existed before the patch;
it is an integration blocker for the new quiet disposition and violates the
existing durable replay contract. Return a retryable handler result without a
send for runtime persistence/read failures, preserving the normal null fallback.

Reproduced with the existing handler fixtures: reject the runtime with
`Communication reply could not be saved. Retry delivery.` Expected
`{ok:false,replied:false}` and no send; actual was `{ok:true,replied:true}`.

## Test evidence

Isolated temporary fixtures live under `/private/tmp/prospect-bugbot-review`.
They copy the repository suites and add failure injection, without changing
tracked source or contacting providers. Command:
`./node_modules/.bin/vitest run --config /private/tmp/prospect-bugbot-review/vitest.config.mjs --maxWorkers=1`.

- Initial harness resolution attempt: exit 1, zero tests. Corrected temporary
  Vitest import alias; no product finding drawn from that setup error.
- Runtime-only reproduction: exit 1; four existing cases passed, one injected
  post-delivery provider failure failed with actual null (5.27 seconds).
- Caller-only reproduction: exit 1; three existing cases passed, one injected
  durable-save failure failed with actual successful reply (6.90 seconds).
- Additional combined stress run: exit 1; five passed, five failed. Host
  contention caused a 20-second import timeout and subsequent shared-mock
  contamination; those two failures are not product findings. The two original
  findings reproduced again. An injected throwing observer also skipped quiet
  detection; the real Langfuse callback protects its provider operations with
  safe(), so observer ordering is optional hardening, not a blocking finding.

Full unit/lint/build and live-model QA belong to the implementation manager and
release owner; this independent review has not run those or claimed their result.

## Confirmed behavior and remaining validation

The tool requires both successful payload and explicit delivered,
non-suppressed notifier result to authorize silence. Audit-only duplicates do
not authorize silence. The normal quiet path does not store fictional assistant
text, emits no outgoing-message event, and resolves the trace reply to empty.
The caller returns handled without an outbox, which the existing Twilio receipt
completion accepts. Durable result metadata supports storing/replaying the
additional disposition. Voice checks channel before suppression; email has a
separate unchanged runtime. Mixed-question usefulness and contextual grounding
remain prompt behavior and require the planned fixture-based real-model QA.

## Correction recheck and final disposition

Independently re-reviewed the stable corrected diff on 2026-09-11. Both P2
findings are resolved; no further blocking bug was found in the focused scope.

- Finding 1: `src/lib/agent/leasing-sms-agent.server.ts:321` now retains the
  confirmed quiet disposition when the final provider request fails. It saves
  the empty reply through the existing billing completion path and does not
  create an assistant message. Successful quiet completion resolves the empty
  reply inside the trace callback. On an actual provider exception, the existing
  trace truthfully records the exception while the runtime retains the delivered
  handoff; it does not fabricate model usage or a successful provider result.
- Finding 2: `src/lib/claw-leasing-bot.server.ts:1167` now releases local claims
  and rethrows durable-path failures. The existing Twilio outer catch marks the
  receipt retryable and returns 503. A normal runtime null still uses the
  established template fallback. Confirmed quiet disposition still completes
  successfully without an outbox.
- Optional observer hardening: `src/lib/agent/leasing-sms-agent.server.ts:272`
  inspects successful delivery before forwarding the event, and isolates a
  throwing observer. It preserves the other observer callbacks.

Independent post-correction command:

```sh
./node_modules/.bin/vitest run tests/unit/leasing-sms-quiet-runtime.test.ts tests/unit/twilio-leasing-inbound.test.ts tests/unit/leasing-sms-agent.test.ts --maxWorkers=1
```

Exit 0; 3 suites passed, 42 tests passed; 38.34 seconds. This includes both
failure-injection regressions, quiet/no-fictional-message behavior, failed
payload, observer exception, audible voice reply, stored quiet replay,
notifier suppression/non-delivery, audit-only duplicates, normal null fallback,
and no template send on durable-path rejection. `git diff --check` also exited 0.

The implementation manager separately reported 72 passing tests across seven
suites; that result is not substituted for the independent evidence above.
Full release gates, real-model conversation QA and non-production end-to-end QA
remain the implementation/release owners' responsibility. This review approves
the focused correction scope, not a production deployment or database change.

