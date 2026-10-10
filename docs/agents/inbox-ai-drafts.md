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

## Server auto-reply on the inbound channel (screen J, D10, Oct 8)

Approval-first drafting above is the path for threads **no server agent answers**. For the channels
where the workspace's own assistant already replies, the SERVER sends on the channel the person used
(SMS -> SMS from the work number, email -> email from the work email) and the thread shows the sent
reply, not a draft. One responder per inbound message:

| Inbound | Responder | Credit | Recorded on the thread as |
| --- | --- | --- | --- |
| Text to the work number (prospect) | `runLeasingSmsAgentTurn` -> `deliverLeasingSmsReply` | `ai_agent_turn`, `ai_turn:sms:...` | outbound `sms` turn (`recordAutoReplyOnSmsNotice`) |
| Email to the work email (prospect / resident) | `runLeasingEmailAgentTurn` / `autoRespondToResidentInboxMessage` via `processManagerAssistantInboundEmail` | `ai_agent_turn`, `ai_turn:email:<inbound email id>` (`email-auto-reply-credit.server.ts`) | outbound `email` turn (`mirrorAssistantEmailConversation`) |
| In-app / portal message, or an email thread no agent answered | the draft below, sent from the browser | none (draft only) | the composer's normal send |

- **Email now reserves credit.** The work-email reply is free to send but the assistant turn is a paid
  `ai_agent_turn`; it used to run with no reservation. `reserveEmailAutoReplyCredit` runs before any model
  work and fails closed: denied, `workspace_unknown` under the pool, a duplicate (a redelivery of a turn
  already run) and an unreadable ledger all mean no model run and no email (the inbound is still
  mirrored). The hold is kept when a reply was produced and released when none was or the turn threw.
  The manager's own mail to their assistant is not an auto-reply and does not reserve.
- **Approval-first still wins, and the hold fails closed.** The email answer is NOT sent — it is stored as
  a pending `requiresReview` draft on the thread (`replyAsReviewDraft`), which the inbox auto-send latch
  never touches — whenever `partyFacingAnswerHold` says to hold: the approval switch
  ("Resident & vendor messages need my approval first", `automationSendMode.partyFacing === "draft"`),
  quiet hours, **or a read that failed** (that resolver throws rather than answering "auto"; the caller
  logs it and holds). Semantics and why there are two resolvers:
  [automated-communication.md](automated-communication.md) § One spine → Send mode. (The SMS agents do not
  consult that switch today.)
- **`inboxAiDraftAutoSend`** (Settings -> Communication, default **false**, unchanged) governs ONLY the
  browser draft above: whether a generated draft is sent without the Send click. It does not gate the
  server agents, which were already auto-replying before this setting existed and are bounded by comms
  credit, consent / opt-out, quiet hours, `requiresReview` and the idempotency keys. Gating them behind a
  default-off flag would have silenced every prospect reply, so the default is not flipped.
- **No second responder.** `threadEligibleForAiDraft` and `/api/portal/inbox-draft-reply` skip
  `claw_leasing_sms` / `claw_resident_sms` threads; for email a server reply is an outbound turn, so
  `inboxThreadManagerReplyPending` is false and the route answers `already-replied`.
- **Never the Team chat.** A `team-thread:*` conversation is teammates talking to each other, not a
  message to answer: it is skipped in the browser and the route answers `team-thread`
  (owner: [communication-inbox.md](communication-inbox.md)).
- **A refused browser auto-send never loops** and In-app is never selected for someone who cannot read it:
  see [communication-inbox.md](communication-inbox.md) § The composer's channel.
- Coverage: `tests/unit/manager-assistant-email-inbound.test.ts` (credit denied -> no model, no send;
  duplicate; ledger down; release on no reply / throw; approval-first draft),
  `tests/unit/manager-inbox-auto-send-refusal.test.tsx`, `tests/unit/sms-notice-channel-stamp.test.ts`.
