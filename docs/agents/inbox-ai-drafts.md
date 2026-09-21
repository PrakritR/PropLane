# Approval-first AI inbox drafts (resident ↔ manager)

PropLane drafts a reply to each incoming **resident** message in the manager
inbox. **Draft with PropLane** inserts that text into the normal thread composer,
where the person can edit it and use the existing Send button and channel menu.
Nothing reaches the counterparty without the normal Send action, except when the
existing explicit auto-send preference is enabled.

## Where it lives

| Piece | File |
| --- | --- |
| Draft generation route (manager-only) | `src/app/api/portal/inbox-draft-reply/route.ts` |
| Draft data type (`InboxAiDraft`) | `src/lib/portal-inbox-storage.ts` |
| Draft status / insert UI | `AiDraftReplyCard` in `src/components/portal/portal-inbox-ui.tsx` |
| Manager composer wiring (generate/insert/discard/send) | `src/components/portal/pro-inbox.tsx` |
| Manager resident-detail composer | `src/components/portal/pro-resident-detail-inbox.tsx` |
| Resident composer | `src/components/portal/resident-inbox-panel.tsx` |

## Data model — drafts never leak to residents

A draft is stored **only** on the manager's own inbox thread row
(`portal_inbox_thread_records.row_data.aiDraft`, status `pending_approval`).
Residents read their own scope (`owner_user_id` / `participant_email` = them),
never the manager's row, so the manager draft is *structurally* invisible to
residents. The resident portal can generate its own local draft through
`POST /api/portal/resident-inbox-draft-reply`; that does not expose the
manager-owned row. Regression basis: a resident-scope row must never carry the
manager's `aiDraft`.

## Flow

1. **Generate** — on inbox sync, `manager-inbox.tsx` auto-requests a draft for
   each incoming inbox-folder thread that still needs a manager reply
   (`inboxThreadManagerReplyPending`) (`POST /api/portal/inbox-draft-reply`).
   Idempotent: a second call returns the cached draft. The route stores the draft
   on the manager row. Resident follow-ups in `messages` (`outbound: false`) still
   qualify; only a manager outbound turn closes drafting.
2. **Insert** — a pending stored draft hydrates the normal composer once when the
   thread opens. A newly generated draft does the same. If unrelated typed text
   is already present, it is kept and the status row offers an explicit
   **Insert draft** action rather than overwriting it.
3. **Edit and Send** — reuses the existing reply path (`handleReply` →
   `/api/portal/send-inbox-message` with `threadId` + `toEmails`), which appends
   the reply to the manager thread and delivers a resident inbox row. The client
   strips `aiDraft` on send, so a sent reply never leaves a lingering draft.
4. **Discard** — removes `aiDraft` from the manager row and blocks
   auto-regeneration for the session. If that draft was inserted, Discard also
   clears it from the normal composer.

## Safety invariants (do not weaken)

- **Approval-gated send is mandatory.** The model path only ever *drafts*; the
  normal composer owns delivery. Even a prompt-injected draft cannot reach a
  resident without Send, except through the existing user-enabled auto-send
  preference.
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
a controlled `expandedId`. Draft status is shared, but there is only one editable
message box: the thread's normal `InboxComposer`. Two invariants keep it working:

- **A controlled selection must survive mount.** `ManagerInbox`'s `[tabId]`
  reset effect fires on mount too; in controlled mode it must NOT call
  `setExpandedId(null)`, or it immediately clears the row the unified list just
  selected (the right pane sticks on "Select a conversation" and the draft
  never appears). Guarded by `if (controlledExpandedId === undefined)`.
- The auto-draft effect is unchanged: it runs once the embedded `ManagerInbox`
  syncs, so opening an incoming resident email in the unified inbox drafts a
  reply exactly as the legacy inbox did. The manager resident-detail and resident
  Communication surfaces also inject route results into their normal composers.
  SMS-only drafting remains deferred: there is no safely reusable SMS draft
  endpoint, and the assistant strip continues to open the assistant rather than
  pretending to draft. Coverage:
  `tests/unit/manager-inbox-ai-draft.test.tsx`.
