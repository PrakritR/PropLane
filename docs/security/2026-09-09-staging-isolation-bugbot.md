# Staging isolation and SMS consolidation bugbot review

Date: 2026-09-09. Base: `26404c432`. Reviewed the working-tree diff in
`/private/tmp/axis-staging-isolation-20260909` before implementation completion.
This is source review, not staging browser QA or a claim that tests passed.

## Initial findings (resolved on follow-up)

1. **High: stale browser persistence can erase incoming SMS history.**
   `sms-inbox-notice.server.ts` now appends messages to a stable row with CAS,
   but `portal-inbox-threads/route.ts` POST still replaces full `row_data` by
   unconditional upsert. Load message A, receive B, then persist a read/archive
   operation based on A: B is deleted. `pro-inbox.tsx` persists local state on
   change, so opening the conversation can trigger this race. Preserve the
   server-owned SMS timeline on client mutations and synchronize metadata
   changes with concurrent appends. A webhook-only CAS test is insufficient.

2. **Medium: archiving/deleting a collapsed legacy phone conversation affects
   only its canonical row.** `sourceThreadIds` is currently consulted only for
   deep-link resolution. `pro-inbox.tsx` sends one canonical row to the upsert
   route and `deleteForever` sends one id. Other database members remain live,
   reappear after refresh, and can duplicate history carried in the canonical
   snapshot. Resolve member ids server-side within authorized owner/phone scope
   and mutate each member without copying a collapsed timeline into a raw row.

3. **Medium: append changes the original message's displayed timestamp.**
   `upsertManagerInboxNotice` changes `row.time` on append, while
   `inboxThreadMessages` derives the root turn's timestamp from that same field.
   Message A at 09:00 followed by B at 10:00 displays A at 10:00. Preserve an
   immutable root timestamp and use it when materializing the root bubble.

4. **Medium: collapse concatenates entire histories in thread order, not turn
   order.** A stable thread with A at 09:00 and C at 11:00 plus a legacy thread
   with B at 10:00 yields B, A, C because sorting uses each thread's newest time.
   Repeated collapses also inherit canonical root direction even when the first
   chronological turn was inbound. Sort individual turns and preserve first
   turn timestamp/direction when selecting the merged root.

## Other observations

- Google Calendar connection project binding blocks unstamped copied
  credentials on staging and explicitly mismatched project references before
  decryption. No concrete defect identified in that change during this pass.
  A fresh Google authorization still enables the chosen real calendar; this
  review does not claim external calendars become isolated after reconnecting.
- Browser guard covers named staging and branch preview hosts. Server guard
  protects the known production reference even if the optional reference is
  absent. No production mutations were performed during review.
- Graph query was attempted but failed because the worktree has no graph file.

## Follow-up review and resolution evidence

Re-reviewed the updated uncommitted diff on 2026-09-09, including the new
`sms-inbox-state.server.ts`, route integration and revised timeline collapse.

1. **Resolved.** Existing authorized SMS rows now use
   `updateSmsNoticeMailboxState`, which loads current history and updates only
   mailbox fields with an `updated_at` CAS. Browser snapshots cannot replace
   message bodies or turns. Concurrent webhook and mailbox writes participate
   in the same CAS protocol.
2. **Resolved.** Archive/read/restore expands members using the authoritative
   owner's normalized phone identity and current archive state; delete resolves
   members from an authorized stored target and reapplies scope to deletion.
   Client `sourceThreadIds` are not trusted as mutation authority. Archived SMS
   members also collapse together in the archived view.
3. **Resolved.** The stable writer preserves `rootAt`; root materialization uses
   that immutable stamp while list activity retains `time`.
4. **Resolved.** Collapse sorts individual turns and copies the selected first
   turn's timestamp and outbound flag into the merged root.

Reviewer validation: `npx vitest run tests/unit/sms-inbox-notice-concurrency.test.ts
tests/unit/portal-inbox-storage.test.ts tests/unit/google-calendar-settings.test.ts`
exited **0**, with **2 discovered files and 8 tests passed**. The requested
`portal-inbox-storage.test.ts` path does not exist and contributed no tests.
The concurrency suite verifies parallel appends, normalized phone identity,
duplicate SID handling, stale browser history preservation, owner isolation,
and legacy member archive expansion. It does not constitute full route or
browser QA.

No unresolved Critical or High findings remain from this review. Runtime staging
QA, broader tests, and deployment verification remain the implementation owner's
responsibility. Source review does not assert that a newly authorized staging
Google connection is a separate external calendar.
