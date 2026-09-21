# Correction plan 1 - dirty composer adopted flag

**Status:** Correction required after Astra review.
**Date:** 2026-09-20
**Parent plan:** `docs/plans/inbox-draft-into-composer/plan.md`
**Branch / worktree:** `akhil/inbox-draft-into-composer` @ `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/10/AXIS-2`
**Base HEAD:** `794b7de5a29f553c0b03f9887fca94fa775af670` (uncommitted feature diff)

## Verdict

Core happy path is good: Draft with PropLane generates via existing routes and
fills the normal composer; dual editable composer is gone; tests and browser
evidence look solid. One material UX correctness bug must be fixed before handoff.

## P1 finding

In `pro-inbox.tsx`, `adopted` is computed as
`adoptedAiDraftThreadId === activeThread.id`.

`insertAiDraftIntoReply` returns `false` when the composer already has unrelated
text (dirty protection + toast). On that failure path it does **not** clear
`adoptedAiDraftThreadId`. If the thread was previously adopted, the status bar
keeps `adopted=true` and **hides Insert draft**, even though the *new* pending
`aiDraft` text is not in the composer.

Repro:

1. Open a thread; pending draft auto-inserts (`adopted=true`).
2. Edit the composer so it no longer matches the AI draft.
3. Click **Redraft** (or otherwise receive a new `aiDraft` text).
4. Toast: draft ready, existing reply kept.
5. Status bar still looks adopted; **Insert draft** is missing.
6. Composer AI menu also omits Draft while `pending_approval`, so the user cannot
   recover without Discard.

Same class of bug may exist in `pro-resident-detail-inbox.tsx` and
`resident-inbox-panel.tsx` if they use a boolean `aiDraftInserted` / thread-id
adopted flag instead of comparing composer text to the current pending draft.

## Required fix

1. Define adopted as: the normal composer currently contains the **current**
   pending draft text (trim-equal), or equivalently
   `adoptedAiDraftByThreadRef.get(threadId) === activeThread.aiDraft.text` **and**
   `replyDraft.trim() === that text`. Prefer a pure render check:
   `Boolean(aiDraft?.text && replyDraft.trim() === aiDraft.text.trim())`.
2. When `insertAiDraftIntoReply` returns false, ensure Insert draft is visible
   for the current pending draft (adopted false for that draft).
3. Keep dirty protection (no silent overwrite); Insert remains the explicit
   force path (`force=true`).
4. Optionally keep Draft with PropLane available in the composer menu even while
   a pending draft exists (as Redraft), so the menu is not a dead end. Status-bar
   Redraft alone is acceptable if Insert is always available when not adopted.
5. Add a unit test covering: hydrated draft → user edits → new draft / redraft →
   toast + Insert draft visible → Insert replaces composer text.
6. Apply the same adopted semantics on resident-detail and resident inbox panels.

## Non-blocking notes (no correction required)

- Full `tsc` OOM at default heap: documented; do not raise heap.
- SMS-only drafting deferred: accepted per plan.
- Send not browser-clicked: acceptable with existing send-path coverage.
- GPT-6 Astra reviewer model slug unavailable in Cursor; this review was done in
  the orchestrating Astra session against the worktree diff.

## Acceptance for this correction

- Unit test for dirty + redraft + Insert path is green.
- Manual or unit proof that Insert appears whenever composer text !== pending draft.
- No dual editable AI composer regresses.
- Targeted vitest + eslint on touched files exit 0.
