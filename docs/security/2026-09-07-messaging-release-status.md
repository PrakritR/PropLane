# Messaging release status — September 7, 2026

The original investigation was restored from stash onto main at `62a8975b`.
Messaging outcome, bot-routing, proposal-persistence, and database-error fixes
landed on main and staging as `98912050`. The retained original investigation is
[`../archive/messaging-failure-analysis-2026-09-05.md`](../archive/messaging-failure-analysis-2026-09-05.md).

## Fresh validation

- Full unit suite after the mobile correction: 1,241 files, 8,434 tests passed.
- Send-inbox-message integration: nine tests passed.
- Authenticated-preflight/public browser smoke: nine tests passed.
- Production build and TypeScript passed with Node 22 and an 8 GB heap.
  The first local Node 23 build exhausted its default 2 GB heap; that was not
  treated as a successful build. Full lint passed: zero errors, 690 warnings.
- Local authenticated manager bot send: HTTP 200, `agentHandled: true`,
  “Reply sent via PropLane,” email/SMS disabled, zero human recipients.
  Database inspection found exactly one user turn and one real bot answer;
  both appeared in the browser after refresh.
- Staging QA on `98912050` verified accepted input and the correct toast,
  foreign-owner refusal, and draft retention on an intercepted 503, with no
  synthetic SMS/mail outbox rows. It also found the two issues below.

## Corrections discovered during staging QA

1. A manager setup banner displaced the phone composer underneath the fixed
   navigation. The follow-up uses parent flex height and the existing measured
   navigation inset. The new authenticated browser regression failed on the
   old stylesheet due to intercepted clicks, then passed on the fixed build
   at 375, 768, and 1280px with an extra banner. Relevant stylesheet and parity
   unit checks passed. This is browser coverage, not an iOS keyboard test.
2. Staging inherited an invalid preview Anthropic key. Vercel logs showed a
   provider 401 after accepted input. A sensitive key already verified by the
   local bot test was added specifically to Preview / `staging`; the new
   deployment must verify an actual bot answer before production promotion.

## Production gate and remaining limitation

Production promotion requires the independent staging reviewer to retest the
new CSS and environment deployment. The earlier acceptance-only result was
not accepted as proof that the bot answered.

A combined rapid-interaction browser test also produced no send request or
toast. Source review found an existing matching failure path: a synthetic
assistant placeholder can render before its stored row is present, while
`handleReply` silently returns when `localRef` lacks that row. The exact failed
run's cause remains unproven. This limitation is not fixed by the CSS change.
The committed layout regression tests only click/focus reachability; it does
not claim that the failed combined send test passed. Independent manual and
staging 503 checks did exercise draft retention successfully.

The security and bugbot reports retain review identities, resolutions, and
other pre-existing messaging limitations. The prescribed
`npx graphify hook-rebuild` was attempted and failed because the npm package
has no executable. No production data migration, uncertain-message resend,
number provisioning, or message to a real human was performed.
