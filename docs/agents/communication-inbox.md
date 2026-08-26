# Communication & inbox (all portals)

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Inbox panels: the standalone page shell is a /demo-only path

`ManagerInbox` (and the resident / vendor / admin inbox panels, which share the
shape) render two ways, and the split decides whether your UI ships at all:

```ts
if (embeddedInCommunication) return inboxBody;   // the real portal stops here
return <ManagerPortalPageShell filterRow={…}>{inboxBody}</ManagerPortalPageShell>;
```

`/portal/inbox/*` redirects to Communication, and `ManagerCommunication` mounts
the panel with `embeddedInCommunication` — so in production the panel is ALWAYS
the embedded branch and Communication owns the title, tabs and filter row. The
standalone `ManagerPortalPageShell` branch is reached only by
`src/components/demo/demo-section-renderer.tsx`. Anything added to that shell's
`titleAside`/`filterRow` (a search box, a filter, an action button) is therefore
**/demo-only dead code in the real portal**, and testing it on `/demo` will not
catch that. Put shared controls in `inboxBody`, or render them in both branches.

Related: controls inside `inboxBody` are gated on `tabId`, which stops being the
row's folder the moment a view spans folders (e.g. search results). Derive
destructive actions and column labels from the ROW's folder, not the active tab
— on the Trash tab the per-row "Delete" is a no-confirm permanent delete, so
inheriting it for a live inbox row destroys real mail. Coverage:
`tests/unit/manager-inbox-search.test.tsx`.

### Communication is one unified, conversation-based inbox (no folder tabs) — ALL portals

Every portal's Communication (manager, resident, vendor, admin) is a single
conversation list + threads, NOT the old Unopened / Opened / Sent / Trash /
Schedule tab bar. Manager, resident, and vendor use the chat two-pane
(`ManagerUnifiedInbox` / `ResidentUnifiedInbox` / `VendorUnifiedInbox`, each
mounting its portal's inbox panel with `suppressListPane` for the thread side);
admin alone keeps its flat table driven by an `"all"` tabId (all non-trash
conversations) plus the archive toggle. Invariants:

- **No folder tabs.** The list shows ALL live conversations (inbox + sent).
  Manager / resident / vendor route on
  `/communication/{active|unread|archived}[/{threadId}]` — `PortalListControlStack`
  destinations that scope that ONE list and deep-link the open thread, never
  folders: `archived` is the trashed view and `unread` is the unread-only view.
  Unread rows also show a per-row dot on `InboxConversationRow` that clears when
  the thread is opened. Admin still routes
  `/communication/inbox/{tab}` and reaches archived through its
  `admin-inbox-archived-toggle` button. Trash/restore live in the open thread —
  never re-add a top-level Schedule/Trash tab. `INBOX_TAB_DEFS` and the standalone
  tabbed panels survive only for the /demo path and legacy route redirects — on
  those three portals every legacy `inbox` / `email` / `sms` path now folds into a
  segment rather than resolving a tab.
- **Scheduled messages render INLINE in the recipient's thread** as a COMPACT,
  collapsible "Scheduled · sends <when> · <subject>" card (`InboxScheduledCard`)
  that expands for the full body + Send now / Cancel send / Edit; Edit is an
  INLINE textarea saved via `onSaveEdit` (no separate form). The standalone
  Schedule table is gone from production. Matching is pure:
  `scheduledItemsForRecipient(email, manual, automation)` in
  `src/lib/inbox-scheduled-thread.ts`. Edit permissions are unchanged —
  resident-originated / resident-side rows are cancel-only (the resident
  scheduled-message route only patches status), so residents pass no `onSaveEdit`.
  `onSaveEdit` MUST reject on failure (see `saveScheduledEdit` in
  `manager-inbox.tsx`) — the card keeps the editor open and shows the error
  instead of closing and discarding the manager's text.
  **Admin is the one exception to "inline".** Its Communication is a flat table
  with no chat pane, and a scheduled send to someone admin has never messaged has
  no conversation row to sit in, so admin keeps a reachable Scheduled view behind
  an `admin-inbox-scheduled-toggle` button beside the archive toggle. It is a
  view toggle, not a folder tab; do not delete it while the admin compose modal
  can still schedule — that leaves scheduled sends uncancellable.
- **`scheduled-message-path-id.ts` must NEVER use the `base64url` encoding
  token.** It runs client-side (building the scheduled-message action URL), and
  Next's browser Buffer polyfill throws "Unknown encoding: base64url" — that
  crashed Send now / Cancel / Edit on automation messages. Use btoa/atob + the
  `base64` transform only (`tests/unit/scheduled-message-path-id.test.ts` guards
  this with a throwing-Buffer shim).
- **Thread messages are channel-tagged** (`InboxBubbleMessage.channel`,
  `InboxChannel = email|sms|whatsapp|gmail`). Email is the only live channel; the
  tag exists so SMS/WhatsApp/Gmail tag into the SAME per-person thread (built on
  the one-thread-per-person `portal-inbox-delivery.ts` foundation) rather than a
  parallel list. Bubbles render the FULL body (pre-wrap, no clamp).
- **SMS UI is gated by `isSmsCommUiEnabled()`** (`src/lib/sms-comm-ui-flag.server.ts`,
  env `SMS_COMM_UI_ENABLED`, default OFF, server-resolved). `render-portal-section.tsx`
  threads it as the `smsUiEnabled` prop into all four Communication components
  (manager / resident / vendor / admin), which gate their compose "via SMS"
  channel, SMS rows, and SMS panel on it. It gates ONLY the UI — SMS transport,
  both SMS agents, and phone provisioning stay live. ⚠️ While hidden, inbound-SMS
  notices must stay visible: `filterEmailInboxThreads(rows, { keepSmsLike:
  !smsUiEnabled })` lets them fall through into the conversation list instead of
  vanishing into the hidden SMS panel. Coverage:
  `tests/unit/unified-conversation-inbox.test.tsx`,
  `tests/unit/resident-conversation-inbox.test.tsx`,
  `tests/unit/vendor-conversation-inbox.test.tsx`,
  `tests/unit/portal-nav-communication-count.test.tsx`,
  `tests/unit/inbox-scheduled-thread.test.ts`,
  `tests/unit/inbox-thread-omnichannel.test.tsx`,
  `tests/unit/sms-comm-ui-flag.test.ts`.
- **Residents can schedule compose** — `PortalMessageScheduleFields` is enabled in
  `ScopedInboxComposeModal` for the resident portal; scheduled rows stay
  cancel-only (no inline edit). Thread actions: **Schedule** in the header and
  **Schedule a message** below existing scheduled cards (`resident-inbox-panel`).
  The floating assistant FAB and in-thread assistant strip are hidden on the
  resident Communication tab (`hideAssistantFab` on `PortalCommunicationShell`).
- **A message enters the thread store only AFTER the send is authorized — on
  both sides.** `/api/portal/send-inbox-message` can still answer
  `403 "You can only message people connected to your account."` well past the
  thread-ownership check, so the route RESOLVES the target thread up front
  (`resolveInboxThreadReplyTarget`, read-only) and defers the write
  (`commitInboxThreadReply`) until after `filterRecipientsBySenderScope` passes;
  the combined `appendInboxThreadReply` is safe only where ownership is the only
  gate. The client mirrors this: `resident-inbox-panel.tsx` renders the
  optimistic bubble in local state but calls `upsertPersistedInboxRows` only
  once a channel succeeds, withdrawing the bubble and surfacing the server's own
  error text on refusal. The reply toast follows the same rule — it is built
  from what each channel ACTUALLY did (`residentReplySentToastMessage`), never
  from the channels the resident asked for, so a failed SMS leg reads "Reply
  sent via email. Text message failed." rather than claiming both. Appending
  first shipped a 403-then-200 sequence where a refused message became the
  thread's `preview`, so the conversation list read "You: …" and residents
  believed a maintenance request had been delivered.
  The manager (`manager-inbox.tsx`) and vendor (`vendor-inbox-panel.tsx`) reply
  paths are NOT migrated yet — they still let a refused reply reach the store —
  so copy the resident panel's shape rather than theirs. Coverage:
  `tests/unit/resident-refused-send-not-delivered.test.tsx`,
  `tests/integration/portal/send-inbox-message.test.ts`.
- **A conversation's `time` is BOTH its label and its sort key, so every writer
  must stamp it identically.** The canonical shape is `formatInboxStamp`
  (`portal-inbox-storage.ts`) — `"Aug 3, 5:31 PM"`, en-US and pinned to
  **Pacific** (`formatPacificDateTime`), which server-side writers call
  directly. The stamp carries no year and no timezone and is re-parsed by
  `parseInboxStampMs`, so a bare `toLocaleString()` is never acceptable: the
  delivery path runs UTC on Vercel while the browser renders local, and the same
  instant stored two ways let an older message outrank a newer one.
  `appendReplyToInboxThread` normalizes a foreign stamp on the way in AND
  advances `thread.time`, and rows sort on `inboxThreadSortMs(id, thread.time)`
  — the thread's own normalized stamp, never a message's raw `at`, with the id's
  millisecond epoch only as a last resort. A withdrawn (refused) optimistic
  reply must restore `time` alongside `messages` / `preview` / `unread`, or a
  send that never happened keeps the thread pinned to the top. Coverage:
  `tests/unit/inbox-thread-recency-order.test.ts`,
  `tests/unit/portal-inbox-send-threading.test.ts`.
- **Client surfaces re-filter on the email embedded in `row_data`, while the
  server authorizes on the `resident_email` COLUMN.** When the two disagree the
  server hands the row over and the client silently discards it — a Fully Signed
  lease vanishes from `/resident/lease` while the charge generator keeps billing
  under it. Only the applications path carries a legacy-domain shim
  (`resident-application-ownership.ts`); lease and messaging do NOT, by
  decision. Repair drifted dev data with
  `npm run test:seed:repair-identity-drift` (dev/test only, verifies after
  writing); it also realigns `profiles.manager_id` / `user_metadata.axis_id`,
  which `residentLeaseAuthorized` compares against `row.axisId` and which hides
  a lease just as effectively as a stale email.

## Inbox attachments

`src/lib/inbox-attachments.ts` (client) + `.server.ts` +
`/api/portal/inbox-attachments`. Images and PDFs, ≤4 per message.

- **The serve route NEVER answers `inline`.** The bytes are attacker-supplied and
  the route is on the app's own origin, so an inline response is a same-origin
  document the uploader authored — survivable while every allowed type was an
  inert raster image, an escalation the moment `application/pdf` was allow-listed.
  `contentDispositionForInboxAttachmentPath` is deliberately type-BLIND so a
  future `ALLOWED_MIME` edit cannot reopen it, and the response also carries
  `default-src 'none'; sandbox`, `nosniff`, and `Cross-Origin-Resource-Policy`.
  `Content-Disposition` does not affect subresource loads, so `<img>` previews are
  unaffected; clicking any attachment downloads it.
- ⚠️ **That download does NOT work in the Capacitor shell.** WKWebView turns an
  attachment disposition into a download only when the host app implements
  `WKDownloadDelegate` (it does not), and it ignores a synthetic `<a download>`
  too — so on iOS the plain anchor is a tap that does nothing.
  `InboxAttachmentChip` (`portal-inbox-ui.tsx`) therefore intercepts the click on
  `isNativeRuntimeSync()` ONLY — never `prefersFileShareSheet()`, which is also
  true in iOS Safari — fetches the same-origin URL with credentials and hands the
  blob to `downloadOrShareFile`. Handing a `File` to the OS never renders the
  bytes on-origin, so this does not reopen the rule above. Any new attachment
  surface needs the same treatment.
- **The storage key carries the uploader's file name**:
  `<userId>/<ts>-<uuid>/<sanitized name>`. It is the only visible label on a PDF
  chip, and nothing else stores it. Keeping it IN the key means the label can
  never drift from the bytes, and every "derive the name from the path" reader is
  correct with no plumbing. `sanitizeInboxAttachmentFileName` restricts it to
  `[A-Za-z0-9._-]` (Supabase key charset; also blocks `..`, separators, and
  `Content-Disposition` header injection). Ownership checks still read `path[0]`,
  and two-segment legacy paths still resolve.
- **Read the name from `?path=`, never the URL's last segment.** The serve URL
  percent-encodes the whole path, so splitting the URL yields the route name;
  that is why recipient-side chips were all labelled "inbox-attachments", and why
  the `row_data` copy has to beat the URL segment. Sender and recipient share one
  helper, `inboxAttachmentChipName`: key segment → stored `name` → URL segment
  (`inboxAttachmentDisplayName`).
- **`.pdf` is a SUFFIX test, not a substring** (`inboxAttachmentLooksLikePdf`) —
  `floorplan.pdf.png` is an image and must preview inline.
- ⚠️ **The `portal-inbox-attachments` bucket's own `allowed_mime_types` and size
  limit gate uploads independently of the route's `ALLOWED_MIME` /
  `MAX_PDF_BYTES`,** and no migration in this repo creates or configures that
  bucket. A type the route accepts but the bucket does not fails as a 500
  "mime type … is not supported" that surfaces to the user as "PDF upload
  failed." Check the bucket when adding a type or raising a size cap.
- Coverage: `tests/unit/inbox-attachments.server.test.ts`,
  `tests/unit/inbox-attachment-display.test.ts`,
  `tests/unit/inbox-attachment-chip.test.tsx`.
