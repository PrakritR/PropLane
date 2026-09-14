# Inbox composer QA maintenance handoff

## Goal and plan

Update the retained resident reply-composer E2E coverage to match the frozen product candidate without changing product code.

- Plan: `docs/plans/2026-09-13-inbox-composer-qa-maintenance-plan.md`
- Workspace: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`
- Branch: `akhil/prp-472-inbox-unread`
- Starting HEAD: `542d11ca0cc20aaf6edb2d7141fa4d2d29afb3f5`
- Current HEAD: `542d11ca0cc20aaf6edb2d7141fa4d2d29afb3f5`

## Changes

The only executable file changed is `tests/e2e/communication-reply-composer.spec.ts`; this handoff document was added beside the plan.

- The resident row label reads `E2E_INBOX_RESIDENT_LABEL`, with `Test Resident` retained as the CI default.
- The test description now covers a resident composer rather than naming one fixture.
- The direct-pane textarea and controls remain scoped through `resident-direct-chat-compose` and its ancestor form.
- Each viewport clears any retained draft before asserting that Send is disabled, then types a draft and asserts Send becomes enabled without clicking it.
- The emoji control is asserted hidden at 375 px and exercised by click at 768 px and 1280 px.
- The attachment label is clicked through a real file-chooser event without selecting or uploading a file. Geometry follows the intentional 36 px phone and 42 px desktop implementation.
- Scheduling is exercised through the current button/menu flow: open, fill the datetime field, confirm, reopen, cancel, and verify the menu closes and `aria-pressed` returns to false.
- The test clears its draft after each viewport and never sends a message.

No production code, database rows, browser state, server process, provider state, or Git history changed in this execution session.

## Independent review

The Luna read-only review confirmed the direct-pane selector, form scoping, responsive emoji behavior, attachment file-chooser path, send-state semantics, and schedule configure/cancel controls against `ResidentDirectChatPane`, `InboxComposer`, `InboxComposerScheduleMenu`, and the unified inbox selection logic. It also confirmed that the root-owned mixed email/native fixture must supply the optional label.

## Validation

- `npx eslint tests/e2e/communication-reply-composer.spec.ts` - exit 0
- `git diff --check -- tests/e2e/communication-reply-composer.spec.ts` - exit 0
- Browser/E2E execution was intentionally left to the root-owned server and data session.
- A graph query could not run because this pooled worktree has neither `.graphify/graph.json` nor `graphify-out/graph.json`.
- Terra attempted `npx graphify hook-rebuild`; it exited 1 with `npm error could not determine executable to run` and changed no graph files.

## Next session

Run the targeted composer E2E against the root-owned server with `E2E_INBOX_RESIDENT_LABEL='PRP-472 SMS probe 1'`. If it passes, continue the root release validation and staging/production gates from the frozen product candidate. Do not add product changes to accommodate this retained test.
