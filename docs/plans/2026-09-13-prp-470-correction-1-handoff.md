# PRP-470 correction cycle 1 handoff

Date: 2026-09-13

Branch: `akhil/prp-470-inbox-loading`

Base and current HEAD: `7b3d464fe2f102a527949044fc0289513d50029f`

Plan: `docs/plans/2026-09-13-prp-470-correction-1.md`

Review URL: `http://localhost:3009/portal/communication/active`

## Result

Correction cycle 1 resolves all four findings from the first Astra review.
Nothing was committed, pushed, promoted, ticketed, or sent to a provider. No
production or staging action occurred.

1. Manager SMS now captures both viewer id and viewer generation. It rejects an
   obsolete response immediately after `fetch` resolves, before a 401/403 can
   mutate the authorization-stop latch, and checks again after JSON parsing.
   The latch resets on an identity transition, while a current viewer's real
   authorization refusal still stops automatic polling and repeated Retry calls.
2. Published manager SMS contacts are owned by the current viewer generation.
   A layout-phase identity transition clears prior rows before paint. Server
   publication, optimistic-contact events, visibility polling, and the direct-send
   refresh all use the same guarded loader. Same-viewer empty optimistic contacts
   survive a server round trip; accepted contacts do not cross viewers.
3. Retry now has `data-attr="communication-inbox-retry"` and continues to return
   the shared promise through the Button handler.
4. The original implementation handoff no longer claims every historical command
   used Node 22. It preserves the successful full-unit result and records the
   reviewer's observed Node 23 worker for that historical run. All correction
   commands below used the explicitly verified Node 22 executable.

`docs/agents/communication-inbox.md` now records the initial-readiness invariant:
manager waits for inbox, applications/contact directory, and enabled SMS;
resident waits for inbox and enabled SMS; successful empty is distinct from
failure; publication and authorization latches are viewer-generation scoped.

## Delegation and inspection

The Sol-medium correction manager assigned non-overlapping scopes. Terra owned
`pro-unified-inbox.tsx` and `communication-inbox-initial-state.tsx`. Luna owned
`inbox-initial-loading-readiness.test.tsx`. The manager inspected each complete
delegate diff and result, reviewed every SMS state mutation and publication path,
removed one new unused test helper, tightened the resident enabled-SMS gating
assertions, and ran the integrated checks below.

The opened/hidden/archived ID sets remain the existing device-local mailbox
preferences. They contain IDs rather than contact rows or authorization state.
Changing their storage model is outside this correction. Contact metadata,
network completion, optimistic publication, and the authorization latch are all
viewer-generation owned.

## Regression coverage

`tests/unit/inbox-initial-loading-readiness.test.tsx` now includes permanent
behavioral regressions for:

- late viewer A SMS 401 and 403 after viewer B receives a retryable failure;
  viewer B's Retry makes a third request and publishes only B's row;
- a legitimate current-viewer A auth halt followed by B login, proving the latch
  resets even without a late response;
- an accepted empty named A contact plus a same-viewer optimistic empty contact;
  both are preserved for A's same-viewer round trip, absent throughout B's load,
  and absent on A's new generation until A's fresh response completes;
- resident enabled-SMS loading while the response is deferred, retryable
  failure/recovery, and rejection of a previous resident viewer's late response;
- a post-ready manager background SMS failure preserving the usable list and
  selected row;
- disabled SMS making no gate-owned SMS requests.

The pre-correction Bugbot probe established the stale-auth defect with exit 1:
only two requests occurred and B remained in error instead of issuing the third
recovery request. The permanent 401/403 cases cover that same observable failure.
The contact and auth-reset assertions directly exercise the old unscoped row and
latch behavior and would fail before the correction.

## Validation

Runner verification:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node -p 'process.version+" "+process.execPath'
v22.23.0 /Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node
exit 0
```

- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx --no-file-parallelism`
  - exit 0; 1 file, 20 tests; final run 9.49s.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/inbox-initial-loading-readiness.test.tsx tests/unit/unified-conversation-inbox.test.tsx tests/unit/resident-conversation-inbox.test.tsx tests/unit/unified-inbox-sms-poll.test.tsx tests/unit/inbox-empty-states.test.tsx tests/unit/portal-inbox-account-switch-leak.test.ts tests/unit/portal-inbox-trash-race.test.ts tests/unit/portal-inbox-merge.test.ts tests/unit/communication-resident-placeholders.test.ts tests/unit/coalesced-refresh.test.ts tests/unit/portal-sync-dedup.test.ts tests/unit/manager-inbox-contacts.test.ts --no-file-parallelism`
  - exit 0; 12 files, 69 tests; 9.98s. The runner summary plus the two
    parameterized status cases yields 20 readiness cases and 10,025 final full-unit
    tests. The earlier progress note that said 70 focused tests was a counting
    mistake; the command's authoritative result is 69.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit`
  - exit 0; 1,423 files, 10,025 tests; 197.55s. Known jsdom navigation/scroll
    notices were the only incidental output.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/eslint/bin/eslint.js .`
  - exit 0; 0 errors and 725 existing warnings. The one new unused-helper warning
    was removed after this run.
- `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/eslint/bin/eslint.js src/components/portal/pro-unified-inbox.tsx src/components/portal/communication-inbox-initial-state.tsx tests/unit/inbox-initial-loading-readiness.test.tsx --quiet`
  - exit 0 after the final test cleanup.
- `NODE_OPTIONS=--max-old-space-size=8192 /Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false`
  - exit 0; 6.89s.
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:/usr/bin:/bin NODE_OPTIONS=--max-old-space-size=8192 npm run build`
  - exit 0; Next 16.3.4 compiled, typechecked, and generated 394 static pages.
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:/usr/bin:/bin npm run ship:preflight`
  - exit 0; 11 checks passed with the four expected local-shell warnings for the
    dirty tree, unavailable production environment values, unavailable production
    migration URL, and missing local Langfuse keys. No promotion followed.
- `git diff --check`
  - exit 0 after all source, test, and documentation edits.
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:/usr/bin:/bin npx graphify hook-rebuild`
  - exit 1 with `npm error could not determine executable to run`. This is the
    known older Python CLI/no npm executable limitation. No global tool, root graph,
    or unrelated worktree was changed.

## Seeded browser QA

The correction manager refreshed the canonical manager and resident private auth
states without logging credentials. The dev server was pinned to port 3009 and
started from this worktree as exec session `83378` with Node 22.23.0,
`SMS_COMM_UI_ENABLED=1`, `SMS_RUNTIME_ENABLED=0`, and
`SMS_OUTBOX_SCHEDULER_READY=0`. `.env` resolved exactly to dev/test project
`emstjswhotsnyksqhqyf`. Existing PRP-470 and PRP-472 fixtures and the stored mobile
draft were preserved. No provider message or data wipe occurred.

Playwright CLI used session `inbox-cycle` and config directory
`/private/tmp/axis-inbox-cycle` for manager checks, plus the existing
`prp470-resident` session for the resident check.

- Delayed real manager inbox: `Loading conversations...` remained visible with
  zero conversation buttons; completion revealed nine rows, including all task
  threads and `Morgan No Message` from the application directory.
- Manager error/Retry: a fresh page with every initial inbox request held at 503
  showed `Could not load conversations.`, only the Retry button in the list,
  and `data-attr="communication-inbox-retry"`. Re-enabling the real response and
  clicking Retry removed the error and restored nine rows.
- Directory-only deep link: selecting `Morgan No Message` produced the encoded
  applicant URL, displayed the named contact, and opened one reply composer.
- Mobile 390 by 844: the base route showed nine rows and no reply composer. The
  directory-contact deep link preserved its URL and opened one reply composer.
- Resident enabled SMS: while the real SMS response was delayed four seconds,
  the resident list showed the loading status and zero conversation buttons.
  Completion revealed six rows with no error.

`npm run sandbox:open -- /portal/communication/active` printed
`http://localhost:3009/portal/communication/active`; a direct unauthenticated
reachability probe returned HTTP 307 to sign-in, confirming the server answered.
The dev process belongs to this executor and can end when the executor completes;
root should restart the same pinned command before review if port 3009 is down.

The previously recorded narrow mobile composer and stored draft remain unchanged
baseline behavior. This correction did not clear or edit the draft.

## Fresh review prompt

Run a fresh GPT-6 Astra review of PRP-470 correction cycle 1 in
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`. Read the original plan,
implementation handoff, first review, correction plan, this handoff, and both
security reports. Inspect the full uncommitted diff and all delegate-owned source
and tests. Recheck the corrected stale 401/403 ordering, viewer-scoped halt reset,
optimistic contact ownership across A to B to A, all SMS publication paths,
resident counterpart behavior, Retry analytics, runtime attribution, and the new
Communication invariant. Treat browser and command evidence as evidence to verify,
not proof by assertion. Request affected security/Bugbot re-review if required.
Do not commit, push, promote, invoke no-mistakes, file Linear, or touch production.
