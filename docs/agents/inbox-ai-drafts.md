# Approval-first AI inbox drafts (resident ↔ manager)

PropLane AI drafts a reply to each incoming **resident** message in the manager
inbox. The manager stays in control: **Approve & Send**, **Edit** (then send), or
**Discard**. Nothing reaches a resident without an explicit manager approval —
there is no auto-send, ever.

## Where it lives

| Piece | File |
| --- | --- |
| Draft generation route (manager-only) | `src/app/api/portal/inbox-draft-reply/route.ts` |
| Draft data type (`InboxAiDraft`) | `src/lib/portal-inbox-storage.ts` |
| Approval UI card | `AiDraftReplyCard` in `src/components/portal/portal-inbox-ui.tsx` |
| Manager wiring (auto-draft, approve/edit/discard) | `src/components/portal/manager-inbox.tsx` |

## Data model — drafts never leak to residents

A draft is stored **only** on the manager's own inbox thread row
(`portal_inbox_thread_records.row_data.aiDraft`, status `pending_approval`).
Residents read their own scope (`owner_user_id` / `participant_email` = them),
never the manager's row — so the draft is *structurally* invisible to residents.
The resident inbox panel does not import `AiDraftReplyCard`, so no draft UI is
ever rendered on the resident side either. Regression basis: a resident-scope
row must never carry `aiDraft`.

## Flow

1. **Generate** — on inbox sync, `manager-inbox.tsx` auto-requests a draft for
   each incoming inbox-folder thread that still needs a manager reply
   (`inboxThreadManagerReplyPending`) (`POST /api/portal/inbox-draft-reply`).
   Idempotent: a second call returns the cached draft. The route stores the draft
   on the manager row. Resident follow-ups in `messages` (`outbound: false`) still
   qualify; only a manager outbound turn closes drafting.
2. **Approve & Send** — reuses the existing reply path (`handleReply` →
   `/api/portal/send-inbox-message` with `threadId` + `toEmails`), which appends
   the reply to the manager thread and delivers a resident inbox row. The client
   strips `aiDraft` on send, so a sent reply never leaves a lingering draft.
3. **Edit** — loads the draft text into the composer; sending goes through the
   same path and clears the draft.
4. **Discard** — removes `aiDraft` from the manager row and blocks
   auto-regeneration for the session.

## Safety invariants (do not weaken)

- **Approval-gated send is mandatory.** The model loop only ever *drafts*; the
  send happens on an explicit manager action. Even a prompt-injected draft
  cannot reach a resident without approval.
- **Drafts are neutral / non-committal.** The system prompt forbids stating
  specific rent amounts, balances, late-fee figures, dates, lease clauses, or
  legal conclusions, and forbids binding commitments — money/legal specifics are
  deferred to the manager (filled via Edit). Resident text is treated as
  untrusted data, never instructions.
- **Ownership preserved.** The route only drafts on a thread the manager owns
  (same boundary as the send path). It never touches resident rows.
- **LLM path.** Single constrained completion via `traceAgentTurn` +
  `client.messages.create` (Langfuse-traced), model `TIER_MODELS.standard`. It
  deliberately does NOT use the tool-grounded agent loop — a tool-grounded draft
  would pull and state real balances, violating the non-committal rule.
- **Money/auth paths unchanged.** No Stripe/rent/fee or authorization logic is
  modified; the send path is reused as-is.

The manager and resident inboxes are two ends of the **same** thread model
(`portal_inbox_thread_records`): an approved manager reply is delivered into the
resident's Communication view as a normal inbox message.

## Unified Communication inbox

The manager Communication page (`manager-communication.tsx` →
`manager-unified-inbox.tsx`) merges email + SMS into one list, but the open
**email** thread pane is still `ManagerInbox` mounted with `suppressListPane` +
a controlled `expandedId`. So the AI draft card is the SAME `AiDraftReplyCard`
from `manager-inbox.tsx` — there is no second implementation, and the approval
gate is unchanged. Two invariants keep it working there:

- **A controlled selection must survive mount.** `ManagerInbox`'s `[tabId]`
  reset effect fires on mount too; in controlled mode it must NOT call
  `setExpandedId(null)`, or it immediately clears the row the unified list just
  selected (the right pane sticks on "Select a conversation" and the AI card
  never appears). Guarded by `if (controlledExpandedId === undefined)`.
- The auto-draft effect is unchanged: it runs once the embedded `ManagerInbox`
  syncs, so opening an incoming resident email in the unified inbox drafts a
  reply exactly as the legacy inbox did. Coverage:
  `tests/unit/manager-inbox-ai-draft.test.tsx`.
