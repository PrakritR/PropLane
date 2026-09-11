# Prospect conversation production first release handoff

Date: 2026-09-11

## Candidate

- Keeper: `prospect-conversation-production`
- Pool checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/4/AXIS-2`
- Base and current uncommitted HEAD: `8ce3868b4e5775661956c6c3f36fcb146bfa931a`
- Plan: `docs/plans/prospect-production-first-release.md`
- No commit, push, branch promotion, deployment, schema write, production data write, or external message was performed.
- The separate unapproved evaluation work in the original workspace was not copied or used.

## Result

The leasing SMS prompt now carries the selected property or room, corrected location, intended duration, urgency, and link history across the recent conversation. It asks at most one useful clarification, distinguishes UW or Seattle from Bellevue, keeps links relevant, answers grounded parts of mixed questions, and treats ready-to-pay or ready-to-move texters as prospects without inventing approval, reservation, or payment.

`escalate_to_manager` now accepts the optional strict input `handoff: "quiet"`. Quiet is authorized only when the existing notification path reports a delivered, non-suppressed result. Under the existing notifier contract, delivered means a durable internal manager notification or an accepted, queued, or deferred manager SMS. It does not mean carrier receipt or manager read confirmation. Notification failure, suppression, and audit-only dedupe preserve the normal prospect reply path.

The leasing runtime observes the typed tool result through the existing observer, records `quiet_handoff` only for SMS, persists that disposition through the existing prepaid-turn completion and replay path, and omits fictional assistant text and outbound analytics. Voice and email retain replies. The inbound caller completes a confirmed quiet receipt without an outbox or template. Durable result read or save failures propagate to the webhook retry path. If the provider fails after a confirmed handoff, the quiet result survives without inventing provider usage or a successful trace result.

This scope adds no scheduler, debounce framework, schema, notification transport, payment capability, approval capability, reservation capability, or new model-callable tool.

## Changed implementation and tests

- `src/lib/agent/leasing-sms-system-prompt.ts`
- `src/lib/tools/domains/leasing-sms.ts`
- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/claw-leasing-bot.server.ts`
- `tests/unit/leasing-sms-agent.test.ts`
- `tests/unit/leasing-sms-quiet-runtime.test.ts`
- `tests/unit/twilio-leasing-inbound.test.ts`
- `docs/ai-assistant.md`
- `docs/agents/sms-system.md`

Release and review artifacts that accompany the candidate:

- `docs/plans/prospect-production-first-release.md`
- `docs/plans/prospect-production-release-readiness.md`
- `docs/security/2026-09-11-prospect-production-security-review.md`
- `docs/security/2026-09-11-prospect-production-bugbot-review.md`

## Validation

- Final integrated focused command: 7 files and 72 tests passed, exit 0, with two workers and a 4096 MB heap.
- Independent security review: PASS, 7 files and 79 tests passed, exit 0, one worker. No unresolved Critical or High finding.
- Independent bugbot correction review: PASS, 3 files and 42 tests passed, exit 0, one worker. Both reported P2 boundaries were fixed and independently reproduced as passing.
- Full unit command: 1,382 files passed and 1 failed; 9,592 tests passed and 6 skipped; exit 1. The only failure was `tests/unit/inbound-email-inbox-route.test.ts`, whose loopback bind returned `EPERM` in the sandbox. That file was rerun alone outside the sandbox and passed 1 file and 6 tests, exit 0. The full run preceded the final two P2 corrections; the final 72, 79, and 42 test runs cover the changed runtime, tool, caller, replay, receipt, notifier, trace, voice, and email boundaries on the final snapshot.
- `npm run lint`: exit 0, 720 existing warnings, 0 errors.
- `npx tsc --noEmit --pretty false --incremental false`: exit 0. The first equivalent invocation reached only an `EPERM` write of `tsconfig.tsbuildinfo`; disabling incremental output removed that sandbox artifact write.
- `npm run build`: exit 0 on the clean final attempt. Next.js 16.3.4 compiled successfully in 3.4 minutes, internal TypeScript completed in 10.8 minutes under host load, and 387 static pages generated. An earlier attempt compiled in 57 seconds but was interrupted with exit 130 after a read-only QA dev server contended for the same `.next`; the server was stopped before the clean passing attempt.
- `git diff --check`: exit 0.
- Root-owned `npm run ship:preflight`: exit 0 with 11 structural checks and 4 warnings. Its environment, migration parity, and Langfuse checks were not configured, so this is not release readiness proof.
- Required graph refresh could not run in this checkout: `npx graphify hook-rebuild` exited 1 because npm could not determine an executable, and the installed `graphify hook-rebuild` exited 1 because that CLI has no such command. No graph artifact is claimed current.

## Model and non-production QA evidence

The sealed harness attempted exactly four sequential `runAgentTurn` cases with the current assembled leasing prompt and fictional in-memory tools. The default-sandbox calls all returned `Connection error.` before any model completion or tool call. The harness exited 0 only because it recorded per-case errors; this is failed evidence and supports no behavior or statistical claim. The requested single escalated retry was automatically rejected because it would transmit the repository's internal leasing prompt and test inputs to the configured external model without specific authorization. No retry or workaround occurred. Details: `/private/tmp/prospect-sealed-model-evidence.md`.

Read-only dev/test QA pinned `/portal/communication/active` and confirmed the expected unauthenticated redirect to sign-in. The server was left running and a final loopback check returned exit 0 and HTTP 307 to sign-in. Review URL: `http://localhost:3000/portal/communication/active`. Cached Chromium launched successfully and loaded the sign-in page. The existing seeded manager credentials did not match an account. A final authorized `auth.admin.generateLink` call verified the canonical dev/test manager and produced a no-send magic link only in process memory; no token or link was printed or retained. The link was not transferred out of that process, so an authenticated browser session and Communication inbox render were not obtained and must not be claimed. No application data changed, although the auth link operation may update dev/test auth token metadata. The browser route does not exercise quiet SMS behavior; hermetic tests cover that behavior. Details: `/private/tmp/prospect-communication-read-qa.md`.

No SMS, email, push notification, manager notification, production endpoint, or application-data write was used for QA.

## Review findings and limits

Security and bugbot both approve the final focused patch. The fresh Astra review in `docs/plans/prospect-production-first-release-review.md` approves a focused keeper commit and fast-forward push for review, while withholding production shipping approval because behavior QA and release prerequisites remain unmet. The inherited low-severity notification wording can still say a manager was notified when a normal reply follows suppression or an audit-only duplicate. That wording never grants quiet authorization. A complete database outage before the quiet disposition is persisted cannot guarantee durable quiet replay; persistence and read failures retain the existing retry contract.

Prompt-guided conversation quality and model choice of quiet handoff are not deterministic. There is no burst coalescing in this release. Real-provider behavioral evidence remains unavailable for the reason above.

## Independent release blockers

Production promotion is not ready and no ladder step should run from this handoff. The root-owned release audit confirms:

1. `main` and `staging` at the base are 27 commits and 141 changed files ahead of production, so the prospect patch cannot be promoted alone.
2. Five communication billing migrations and their required functions are absent from both staging and production. The leasing runtime reserves credit before running.
3. The staging alias serves commit `0b6d567`, not branch commit `8ce3868`; the relevant GitHub deploy job was skipped because deployment was not configured.

See `docs/plans/prospect-production-release-readiness.md` for exact read-only evidence and the required repair and QA sequence. These blockers are independent of the focused patch.

## Next owner action

Run the fresh Astra feature-cycle review against this uncommitted keeper and its independent security and bugbot reports. If code changes, rerun the focused tests and notify the independent reviewers because their hashes identify the current snapshot. Do not commit or push until that review is complete. Reconcile the release prerequisites before any main, staging, or production promotion.
