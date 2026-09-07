# Messaging reply outcomes — security review, 2026-09-07

## Scope and verdict

Reviewed base and checkout HEAD: `62a8975be7b699f37c088377faca59ed5c6af890`.
Reviewed the uncommitted messaging patch restored from stash
`78301afdcd437b3436de678fb549b26378ce1551`, including all six changed source files,
the related regression tests, and the existing send/confirm authorization paths.
The SHA-256 of `git diff -- src` at review was
`d401f7cca7dc0508c222758148dc0fcac99954010ea6b60726061f1431ac6fdd`.
After the analytics fix below, the re-reviewed source diff SHA-256 is
`dc655c7544689b9d11a6f2d9d4ed757ddafa86e5aad1c9d62004a7dafaa387cb`.

No Critical, High, or Medium security finding was identified in this patch.
Security review permits landing subject to the other ship-gate checks and
dedicated staging QA. This is source and mocked-unit verification, not a
production penetration test or proof of external email/SMS delivery.

Read the applicable `AGENTS.md`, `docs/ship-gate.md`, `docs/ai-assistant.md`, and
`docs/observability.md`. No application code was changed by this reviewer;
no network writes or outbound messages were performed.

## Findings

### Low, resolved — success analytics preceded reply persistence

At review, `src/lib/agent/manager-inbox-agent.server.ts:123` emits
`assistant_message_sent` before the empty-reply check and before
`commitInboxThreadReply`. A failed reply commit can therefore emit both a sent
event and `assistant_reply_failed`. This does not disclose data or authorize a
write, but can confuse the failure analysis motivating this patch. Recommend
moving the success event after the successful reply commit, or explicitly
documenting that the event measures accepted input rather than a saved reply.
Resolution: the implementer moved the event after the awaited successful
`commitInboxThreadReply`. Re-review confirmed the final order and the regression
test now requires failure telemetry and absence of success telemetry when that
commit rejects. No unresolved security findings remain.

## Authorization and failure evidence

- `resolveInboxThreadReplyTarget` retains the owner/participant/Communication-edit
  authorization check before its canonical-thread fallback. The fallback compares
  the exact `agent_notice_${storedOwnerId}` and the manager scope. A display name
  of “PropLane Assistant” alone never selects bot routing.
- `src/app/api/portal/send-inbox-message/route.ts:302` still requires the stored
  thread owner to equal the authenticated user before starting the manager bot.
  Being a delegated editor or participant does not grant the owner's bot context.
  The bot context separately verifies manager/owner/admin role.
- The restored canonical `agent_notice` type preserves bot routing without
  changing ownership, scope, recipient permissions, or external dispatch.
  Notice subtype becomes message metadata and is not treated as authorization.
- Manager proposals use the existing `createPendingActionForUser` helper with
  context-derived `landlordId` and `userId`, explicit `portal: "manager"`, and
  the server-produced trace id. `allowWriteTools: []` remains in the agent loop;
  proposing an action cannot execute it. Existing actor-scoped, portal-bound
  confirmation remains the execution gate.
- The new PostHog properties contain fixed portal/surface/reason values and a
  registry tool name. They do not include message text, addresses, emails, phone
  numbers, or tokens. Existing Langfuse actor and prompt attribution is preserved.
- Reply persistence now rejects database read/write failures and missing threads,
  using fixed user-facing messages with database errors only as causes. The
  send route commits the user turn before starting the bot, and the bot reports
  a failed response commit as `replied: false`.
- The UI change adds PropLane outcomes to the existing channel accounting. It
  neither adds a recipient nor retries messages. The resident rollback guard
  preserves a successful in-app send when an optional external leg fails; the
  shared helper retains the explicit no-resend warning for an unknown SMS outcome.

## Validation

Reviewer command:

```sh
npx vitest run tests/unit/portal-inbox-thread-reply.test.ts tests/unit/inbox-reply-persistence-failure.test.ts tests/unit/manager-inbox-agent.test.ts tests/unit/agent-notice-single-thread.test.ts tests/unit/tools/confirm-gate-portal-scope.test.ts
```

Result: **5 files passed, 26 tests passed**. These exercise owner/participant and
delegation scope, foreign-thread refusal, canonical recovery and name spoofing,
failed/missing persistence, proposal/trace binding, notification thread identity,
and cross-portal confirm rejection. Database/model/transport dependencies are
mocked; staging authentication and real deployment checks remain separate gates.

After the telemetry fix, reran
`npx vitest run tests/unit/manager-inbox-agent.test.ts`: **1 file passed,
3 tests passed**, including the new success/failure event assertions.

## Boundaries

This patch does not make transcript read-modify-upsert atomic and does not prove
that an externally accepted SMS/email ultimately reached its recipient. Those
pre-existing delivery and concurrency concerns must not be inferred to be solved
from the corrected toast or this review.
