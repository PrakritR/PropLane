# Inbox "Draft with PropLane" → normal composer

**Status:** Plan (Astra). Do not implement in the planning session.
**Date:** 2026-09-20
**Requester:** Akhil
**Branch at plan time:** `main` @ `6f24d93b712f140d16af5f10e14b1fd88edd61aa` (local tree is dirty and behind `origin/main`; execution must use a clean dedicated branch / worktree)
**Area docs:** `docs/agents/communication-inbox.md`, `docs/agents/inbox-ai-drafts.md`

## Goal

Make the Communication thread **Draft with AI / Draft with PropLane** control actually generate a reply draft, then put that draft text into the **normal chat reply text box** (the same `InboxComposer` the person types in), not a separate AI-only composer card.

## User-visible problem today

1. Manager / resident person threads render `AiDraftReplyCard` with `generateLabel="Draft with AI"` above the normal reply composer (`pro-inbox.tsx`, `pro-resident-detail-inbox.tsx`, `resident-inbox-panel.tsx`).
2. On generate, the API path works (`POST /api/portal/inbox-draft-reply` / resident equivalent), but the result lands in a **second** composer (`data-attr="inbox-ai-draft"`) with Approve / Discard, while the normal box (`Write a reply…`) stays empty.
3. That feels like "the button does nothing" relative to where people type, and forces a second send surface.
4. Dead / misleading sibling: `InboxAiAssistBar` ("Ask PropLane Assistant") exists in `portal-inbox-ui.tsx` but is **never mounted**. SMS threads only have `InboxThreadAssistantStrip` ("Ask PropLane"), which opens the assistant rail and does **not** draft into SMS compose.

## Desired behavior

| Step | Behavior |
| --- | --- |
| Idle | One compact control near the thread composer: prefer label **"Draft with PropLane"** (keep `data-attr="inbox-ai-draft-generate"`). |
| Click | Call existing draft routes (force regenerate when user asks). Show a clear drafting state on that control / composer (disabled + "Drafting…"). |
| Success | Insert draft text into the **normal** reply state (`replyDraft` / `draft` / SMS `draft`). Focus the normal composer. |
| Edit / send | User edits and sends exactly as a manual reply (existing send path + channel picker). No separate Approve composer. |
| Failure | Inline error + retry on the same control. Do not clear existing typed text unless the user confirms overwrite (see edges). |
| Discard | If a pending server `aiDraft` was applied into the composer, clearing the composer / an explicit dismiss clears local text and clears stored `aiDraft` the way Discard does today. |

## Product decisions (locked)

1. **Reuse the existing draft APIs and prompts.** No new model path. Keep neutral / non-committal draft rules in `docs/agents/inbox-ai-drafts.md`.
2. **Approval gate stays:** sending still requires an explicit Send on the normal composer. Inserting text is not auto-send unless the existing auto-send setting is on **and** the product already auto-sends today.
3. **Unify pending drafts into the normal box.** If a thread already has `aiDraft.status === "pending_approval"`, hydrate that text into the normal composer when the thread opens (once), instead of rendering the separate `AiDraftReplyCard` composer. Remove the dual-composer UX for person email/in-app threads.
4. **Keep channel picker on the normal composer** (already present). Do not keep a second channel picker only on the AI card.
5. **SMS:** Add the same Draft with PropLane control above the SMS `InboxComposer` when a draft API can be reused or a thin SMS-context draft endpoint already exists. If SMS cannot safely reuse `/api/portal/inbox-draft-reply`, document the gap in the handoff and ship email/person threads first rather than inventing a second model path without evidence.
6. **Do not** change PropLane Assistant chat / `InboxThreadAssistantStrip` into a silent no-op; that remains "open assistant". Drafting is the dedicated Draft control.
7. **Dead code:** Delete `InboxAiAssistBar` if unused after this change, or replace its intended use with the single Draft control. Do not leave a second unlabeled chip.

## Out of scope

- Changing Langfuse / tool-loop architecture for drafts
- Auto-sending without the existing auto-send preference
- Reworking Ask PropLane assistant rail behavior beyond not confusing it with Draft
- Production / staging promotes
- Linear / Lavish (Akhil process)

## Implementation sketch

### UI

- Collapse `AiDraftReplyCard` usage for the pending-draft composer into a small generate control + drafting/error states (either slim the component or add a `variant="composer-inject"`).
- On success in:
  - `pro-inbox.tsx` → `setReplyDraft(text)` and clear/consume `aiDraft` presentation
  - `pro-resident-detail-inbox.tsx` → `setDraft(text)`
  - `resident-inbox-panel.tsx` → `setReplyDraft(text)`
  - `pro-sms-panel.tsx` → `setDraft(text)` if in scope
- When hydrating from stored `aiDraft`, sync once per thread id; do not fight user edits on every render.
- If the normal composer already has non-empty user text and generation succeeds, prefer: overwrite only when the current text equals the previous AI draft, otherwise prompt / toast "Replace your draft?" with Replace / Keep. Simplest robust default if timeboxed: **replace and toast** "Draft inserted — undo by editing" only if the box was empty or matched the prior AI text; if dirty with unrelated text, toast and **do not** overwrite.

### Data

- Continue storing `aiDraft` on the manager row for idempotency / auto-draft sync if that path remains, **or** clear it once injected into the composer and treat the composer as source of truth until send. Prefer: keep server draft until send/discard so refresh can rehydrate; client presentation is composer-only.
- On successful send, keep clearing `aiDraft` as today.

### Docs

- Update `docs/agents/inbox-ai-drafts.md` so "Approve & Send" / Edit describe the **normal composer**, not a second card.
- Note Communication surfaces covered.

### Branching

- Do **not** commit into the dirty `main` worktree.
- Create `akhil/inbox-draft-into-composer` from an up-to-date base (prefer `origin/main` or current local HEAD if Sol cannot fetch) in a **treehouse / clean worktree**.
- No force pushes. No production writes.

## Files likely to change

- `src/components/portal/portal-inbox-ui.tsx` (`AiDraftReplyCard` / remove or wire `InboxAiAssistBar`)
- `src/components/portal/pro-inbox.tsx`
- `src/components/portal/pro-resident-detail-inbox.tsx`
- `src/components/portal/resident-inbox-panel.tsx`
- `src/components/portal/pro-sms-panel.tsx` (if SMS in scope after probe)
- `docs/agents/inbox-ai-drafts.md`
- Tests: `tests/unit/manager-inbox-ai-draft.test.tsx`, `tests/unit/inbox-reply-channel-picker.test.tsx`, plus new/updated coverage for "generate → normal composer value"

## Acceptance criteria

1. Clicking **Draft with PropLane** on an eligible Communication person thread calls the draft API and shows drafting feedback.
2. On success, the generated text appears in the normal reply text box; the separate AI draft composer is gone for that flow.
3. User can edit and Send via existing channels; message delivers as today.
4. Failure shows a retryable error; typed text is not silently wiped when dirty.
5. Opening a thread with a stored pending `aiDraft` still surfaces that text in the normal box.
6. Resident manager-detail and resident portal Communication match the same UX where they already expose Draft with AI.
7. Unit tests updated/green for the new presentation; no new secrets; no production DB writes.
8. Browser proof on seeded non-demo data for manager Communication happy path + empty thread + error path; Review URL recorded.
9. Handoff HTML written under `docs/plans/inbox-draft-into-composer/`.

## Test matrix

| Case | Layer |
| --- | --- |
| Generate success fills normal composer | unit + browser |
| Generate while drafting disables double-click | unit |
| Stored pending `aiDraft` hydrates composer | unit (extend `manager-inbox-ai-draft.test.tsx`) |
| Dirty composer not overwritten | unit |
| Send after insert clears draft + delivers | unit / existing send tests |
| Discard / clear clears stored draft | unit |
| API error shows retry | unit |
| Assistant strip still opens assistant (not draft) | unit smoke |
| SMS draft if shipped | unit + browser |
| Typecheck / lint on touched files | tsc + lint |
| Memory-safe: one heavy suite at a time | process |

## Risks

- Dual state (`replyDraft` vs `aiDraftEditText`) can desync — delete the second editor state where possible.
- Auto-send + composer inject could surprise; keep existing auto-send gating and add a regression test.
- SMS draft without thread id mapping may be unsafe — fail closed / defer rather than invent.
- Dirty local `main` — isolation via worktree is mandatory.

## Execution constraints for Sol

- Read `AGENTS.md` + `docs/agents/AGENTS-akhil.md` + area docs first.
- Terra/Luna model slugs are **not** in the Cursor allowed subagent model list; implement directly (optional `explore` / `generalPurpose` with `inherit` only for read-only inventory).
- Do not run no-mistakes.
- Do not file Linear / open Lavish.
- Stop servers started for this task before handoff.
- Return a durable execution handoff HTML + markdown under `docs/plans/inbox-draft-into-composer/`.
