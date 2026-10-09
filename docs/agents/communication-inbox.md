# Communication & inbox (all portals)

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Sending a message — New message is the chrome

Any portal send (invite, reminder, listing share, notice) uses the New message
field order. Do not invent a second compose. Full rule:
[`send-message-compose.md`](send-message-compose.md).

## `recordRef` — a thread can be labeled with the record it is about

A thread's `row_data` may carry `recordRef: { kind, id, label }` (kinds:
`property | resident | payment | outgoing-payment | lease | application |
inspection | service | task | vendor | tour | booking | document`, exported
from `src/lib/portals/record-kinds.ts`). It is stamped by the send path
(`deliverPortalMessageThreadSide` / `deliverPortalInboxMessage` /
`commitInboxThreadReply` in `src/lib/portal-inbox-delivery.ts`, and the
`recordRef` field accepted by `POST /api/portal/send-inbox-message`) whenever
the caller composed from inside a record's own Communication section
(`RecordCommunicationSection`, `src/components/portal/record-communication-section.tsx`)
or an automated reminder already knows its subject row
(`recordRefFromReminderRow`, `src/lib/reminders/reminder-record-ref.ts`).

It is a LABEL for display and filtering, **never an authorization grant** —
every send still authorizes the recipient first and appends second, exactly
as every other send does (see "A message enters the thread store only AFTER
the send is authorized" below). Once a thread has a `recordRef`, a later reply
never overwrites it with a different one — the ref belongs to whoever first
composed from that record, not to whatever record a later replier happens to
be viewing. A thread written before this existed, or whose subject kind is
not in the mapped set, carries none and renders no chip — never a guessed one.

**A turn carries its own record too (Oct 8, plan admin-money-1008 D9).** The thread keeps the first ref, so a later
job with the same vendor or resident reuses the thread under the earlier job's ref. Every message the send path
appends is therefore also stamped with the `recordRef` it was composed from (`InboxThreadMessage.recordRef`; the
root turn in `body` belongs to the thread's ref). A service's Communication matches a thread through its
`recordRef`, its `workOrderId` (stamped with the `recordRef` on a dispatch-agent thread when
`ensureVendorAgentSession` creates it, and backfilled on the next refresh; the thread id is also
`vendor_agent_<work order>_<vendor>`) or any of its turns, and shows just that service's turns
(`threadAboutService` / `messageAboutService`, `src/lib/service-communication-scope.ts`; the "Everyone" tab merges
the parties' threads - `docs/agents/services-system.md` § Communication). It is still a label, never an
authorization grant.

`CommunicationThreadFilters.recordRefs` / `.recordKinds`
(`src/lib/communication-thread-filters.ts`) narrow a thread list to one record
or one "About" kind; they only ever REMOVE rows the viewer's other
authorization already let them see, never add one. The manager, resident, and
vendor Communication components (`pro-unified-inbox.tsx`,
`resident-communication.tsx`, `vendor-communication.tsx`) render a small
clickable chip on a thread that carries a `recordRef`, using
`recordRoutePath()` to build the record's route.

`RecordCommunicationSection` (`src/components/portal/record-communication-section.tsx`,
the record-page Communication tab) renders ONE merged timeline of EVERY
conversation with that record's contact(s) — not just the record-tagged
thread. A thread is included when its stamped `recordRef` matches this record
OR its counterparty email matches one of `contactIds` (case-insensitive) OR
(when the thread shape carries one) its phone matches `contactPhone` —
INCLUDING archived (folder `"trash"`) threads, across every property. Their
messages interleave chronologically into one timeline; day dividers and the
per-message channel tag both already come from `InboxMessageTimeline` /
`buildInboxMessageTimeline` reading that merged order, so nothing new was
added to the bubble for this. There is no "N other conversations with this
contact" link anymore — this pane already shows all of them. Replying still
targets exactly one thread: `primaryThread` prefers the one stamped with THIS
record's own `recordRef`, else the newest thread with the contact, else none
(a send then stamps a brand-new thread with this recordRef), exactly as
before.

**For a manager it is the full thread pane**, not a compact card: the renderer
defaults `fill` to `role === "manager"` (`record-section-renderers.tsx`), so every
manager record's Communication section fills the page, pins the real composer with
its Schedule-for-later clock, and draws scheduled sends as the same pinned
"N scheduled" card the main thread uses (`useThreadScheduledCards` feeding
`InboxThreadView underHeader`, matching "Scheduled messages sit in a bar under the
conversation name" below). Same composer and same send path — nothing about
scheduling is record-specific.

It reads the SAME persisted inbox cache every other Communication surface
does, via `loadPersistedInbox` — synchronous, and empty on a cold page load
until `syncPersistedInboxFromServer` completes at least once. That gap used to
render the confident "No messages about this X yet" empty state before the
real thread had even been fetched, so reloading the exact same conversation
intermittently "had no messages" depending on network timing.
`initialSyncDone` distinguishes "still checking" from "checked, and there
really is nothing" — the empty label only ever reflects the completed sync's
own answer. See `tests/unit/record-communication-section.test.tsx`.

## Admin Communication is the manager's inbox over an adapter

`ManagerUnifiedInbox` takes a `CommunicationInboxAdapter`
(`src/lib/communication/inbox-adapter.ts`, default `managerInboxAdapter`). The
adapter is everything that differs between whose conversations these are:

- the thread store (`storageKey`, `loadCachedThreads`, `syncThreads`,
  `threadsChangedEvent`), what the list is built from (`buildListThreads`: the
  manager collapses person rows and pins the PropLane Assistant, admin does
  neither), and optional `emailMutations` for archive / restore / delete when the
  rows do not live in the persisted inbox cache;
- the text stream (`loadSmsConversations`, `invalidateSmsConversations`,
  `smsDetailPath` - absent means no per-conversation read, so the inbox never asks
  the manager route about an admin conversation - and `smsArchivable`);
- the contact directory (`syncDirectory`, manager only), `directChat` (the
  manager's folded email + text pane), `identityBoxes`, and `ThreadPane` when the
  portal draws its own thread pane (admin).

`managerInboxAdapter` (`communication-adapters/manager-inbox-adapter.tsx`) only
wraps the calls the inbox always made; the manager page is unchanged by it.
`createAdminInboxAdapter` (`communication-adapters/admin-inbox-adapter.tsx`) serves
admin:

- **Conversations** are the `scope: "admin"` rows (support@ mail, portal users
  writing to PropLane, messages admin composed), mapped to `PersistedInboxThread` by
  `adminInboxMessageToThread` so the list model and merge rules are shared. Id,
  subject, folder, unread (an inbox row with `read === false`), the side that wrote
  each turn (`ADMIN_REPLY_AUTHOR_LABEL`) and the stamps (`formatInboxStamp`, label and
  sort key at once) survive the mapping; a trashed message keeps `trashedFrom` as
  `previousFolder`, so Restore returns it to the folder it came from (archive survives).
  Reading is `GET /api/portal-inbox-threads?scope=admin`
  (`syncInboxMessagesFromServerWithStatus`, which reports a failed read so the list
  shows Retry rather than an empty inbox).
- **Text conversations** come from `GET /api/admin/sms-conversations` and merge into
  the same list; the thread opens `ManagerSmsPanel` with
  `endpoint="/api/admin/sms-conversations"`, `allowDelete={false}` and
  `allowArchive={false}` - archive state is the manager's
  (`/api/manager/tour-follow-ups`), admin oversight of the shared line has none, so
  admin text rows have no row menu. `smsUiEnabled` off = the stream is not read.
- **Identity boxes** are the support address (`PUBLIC_SUPPORT_EMAIL`, the mailbox
  inbound mail is routed from - `docs/agents/inbound-email-inbox.md`) and, when the
  text stream reported one, its number (`AdminWorkIdentityCard`). No "set up" prompt:
  admin does not provision either.
- **Replies** go to `POST /api/admin/inbox-reply` and are appended only after the
  server accepted them (authorize, then append). A reply to a support thread is still
  receive-only: it never reaches the sender. "Schedule for later" is offered only for a
  portal user (manager / resident / vendor) with an address.
- **Mutations** (`adminEmailMutations`) go through the admin store
  (`moveInboxMessageToTrash` / `restoreInboxMessageFromTrash` /
  `permanentlyDeleteInboxMessage`); the bulk hook takes them as `emailMutations`
  and otherwise uses the storage-key based ones.

A new Communication surface is an adapter, not a copy of the inbox. Both adapters
are held to one contract in `tests/unit/communication-inbox-adapter-contract.test.tsx`.

## SMS notices while the SMS panel is hidden

`upsertManagerInboxNotice` stores one thread per mailbox owner and normalized
counterparty phone. It appends with optimistic concurrency checks and supports
message-id deduplication. `rootAt` preserves the first turn's time independently
of the conversation's latest stamp.

Namespace the delivery id per producer (`relay_`, `resident_`, `leasing_`). One
inbound text can be mirrored by two producers that share its Twilio SID, so a
bare SID makes the second mirror look like a retry of the first and it is
dropped.

Every notice turn is stamped `channel: "sms"` (root: `rootChannel`), and a reply the server's SMS agent
sent is appended as an outbound turn by `recordAutoReplyOnSmsNotice` (idempotent on
`auto_reply_<inbound sid>`, append-only, never creates a thread) — see "The composer's channel" below.

Historical `claw_lease_*` / `claw_resident_*` notices are folded on reads using
server-projected ownership plus an explicit phone label. Never infer phone
identity from message text or a contact name. This notice grouping does not
change the role-scoped SMS transport keys or authorize cross-person email links.

Mailbox actions on these server-owned SMS threads update state only; they cannot
replace message history from a stale browser snapshot. Archive, restore, and
delete derive historical members from the authorized stored owner and phone,
not client-provided member ids. Live and archived members are kept separate.

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

### Communication is one unified, conversation-based inbox — ALL portals

Tour-request portal notices may carry `smsConversationKey` only after the server
proves an existing prospect/applicant SMS conversation by exact owner, phone,
work number, and role. The unified manager list uses that key on both channel
rows, so only that SMS conversation folds with the portal notice. Other roles
or owners on the same phone remain separate. This association never creates a
synthetic SMS message or provider SID; SMS turns still represent real transport.

Every portal's Communication (manager, resident, vendor, admin) is a single
conversation list + threads, NOT the old Unopened / Opened / Sent / Trash /
Schedule tab bar. Manager, resident, and vendor use the chat two-pane
(`ManagerUnifiedInbox` / `ResidentUnifiedInbox` / `VendorUnifiedInbox`, each
mounting its portal's inbox panel with `suppressListPane` for the thread side).
**Admin is the manager's page over admin's data** (captain, 2026-10-08, plan
admin-money-1008 D5): `AdminCommunication` mounts the same
`ManagerUnifiedInbox`, handing it the admin adapter. There is no admin-only inbox
component and no table exception (`admin-inbox-client.tsx` is gone). See
"Admin Communication is the manager's inbox over an adapter" below. Invariants:

- **Manager, resident, vendor AND admin Communication have Active | Archived
  command tabs** under the work number/email boxes (`inbox-list-segments`) — same Tours
  chrome: label + count badge + cobalt underline (`DestinationNav
  appearance="command"`). Unread stays in Filter (All conversations, Read,
  Unread) for the current tab — Filter does not list Archived on any of the
  four (`CommunicationFilterSortFields`'/`CommunicationStatusFilterDraft`'s
  `hideArchived`). Filter also drops a section a surface has no answer for:
  admin passes `hideHouse` / `hideRole` / `hideAbout` (no houses, one kind of
  person, no record link). The manager's Filter carries one extra entry on a
  phone only — **Scheduled N** (`showScheduled={isPhone}`,
  `communicationScheduledOption`, counted by `useScheduledSendCount` from the
  same two sources the Schedule panel reads). It is a list VIEW, not a thread
  filter: it swaps the list body for the Schedule panel and the threads
  underneath stay Active (`scheduledView` in `pro-unified-inbox.tsx`). It exists
  because a phone has no Schedule tab and the Active | Archived tabs never grow
  one.
  `/communication/{active|unread|archived}[/{threadId}]` deep links remain on
  every portal. `unread` is Active + unread filter (admin folds `unread` into
  Active, as the manager route does). Admin's old `/communication/inbox/{tab}`
  and flat `/communication/{unopened|opened|schedule|sent|trash}` paths redirect
  to the segment they became (trash is Archived, every other folder is Active).
  Trash/restore live in the open thread —
  never re-add a top-level Schedule/Trash tab. `INBOX_TAB_DEFS` and the standalone
  tabbed panels survive only for the /demo path and legacy route redirects — on
  all four portals every legacy `inbox` / `email` / `sms` path now folds into a
  segment rather than resolving a tab.
- **Switching the Active ⇄ Archived tab is instant on all four, with no
  skeleton and no refetch (captain, 2026-09-26 for vendor, Oct 2026 for
  resident: both match manager's UI exactly).** `InboxListSegmentTabs`
  (`portal-inbox-ui.tsx`) takes an `interceptNavigation` prop; every list
  passes it and preventDefaults a plain left click (no
  modifier key), calling `onChange` instead of letting the `<Link>` navigate.
  `ManagerCommunication` (`pro-communication.tsx`), `ResidentCommunication`
  (`resident-communication.tsx`), `VendorCommunication`
  (`vendor-communication.tsx`) and `AdminCommunication`
  (`admin-communication.tsx`) each own the segment as CLIENT state
  (`useCommunicationListSegment`, mirroring `useCommunicationThreadId`) and
  push the URL with `history.pushState`
  (`selectCommunicationSegmentUrl`, `portal-communication-nav.ts`) rather than
  navigating — a real App Router navigation to a different `[segment]` route
  was what remounted `ManagerUnifiedInbox`/`VendorUnifiedInbox` and reset
  their already-loaded lists on every tab click. Browser back/forward still
  updates the segment via `popstate`. `ManagerUnifiedInbox` additionally
  renders the last-ready snapshot for this viewer+workspace immediately on an
  actual remount (sidebar navigation away and back), from a module-level
  cache (`managerInboxSnapshotCache`), and revalidates silently underneath — a
  first-ever session load has no cache entry and keeps the original
  all-sources-ready invariant
  (`tests/unit/inbox-initial-loading-readiness.test.tsx`); `VendorUnifiedInbox`
  has no equivalent snapshot cache yet. Manager archive/restore are optimistic
  (the row moves and counts update immediately; a persistence failure rolls
  the exact render back and toasts) and every selected SMS row
  archives/restores in parallel (`Promise.allSettled`), not a sequential loop —
  vendor's `CommunicationRowActions` reuses the same shared archive/restore
  path.
- **An archived conversation must never resurrect on its own.** Three
  delivery-side bugs used to do exactly that (captain resurrection sweep):
  (1) `findExistingPortalMessageThread` (`portal-inbox-delivery.ts`) only
  matched a thread whose CURRENT folder equalled the side being delivered, so
  once a thread was archived (folder `"trash"`) the next message to/from that
  person inserted a brand-new duplicate row instead of appending to the real,
  archived one; (2) `upsertManagerInboxNotice`
  (`sms-inbox-notice.server.ts`) forced `folder: "inbox"` on every append
  regardless of direction, so even the MANAGER's own outbound relay text
  un-archived an SMS notice thread; (3) the SMS archive poll
  (`mirrorManagerSmsArchivedFromServer`, `manager-sms-archive.client.ts`)
  replaced the ENTIRE locally-archived id set with only what the current
  response explicitly marked `archived: true`, so a conversation merely
  absent from one response (a partial payload, a different member-key
  spelling) silently lost its archived flag. The fixed policy, applied
  consistently: **only a genuinely INBOUND message from the counterparty may
  reopen (un-archive) a thread; an outbound or automated append (a manager
  send, a reminder, a notice, an assistant copy) never does.** A same-person
  archived thread that a past instance of bug (1) already forked into a
  separate near-empty active duplicate heals back into one conversation on
  READ, in `collapsePersonInboxThreads` (`portal-inbox-storage.ts`, only when
  its caller asks to merge across folders) — the more recently active thread
  wins folder and every message from both merges into one timeline; no
  migration needed. A resident-directory placeholder row
  (`buildResidentPlaceholderInboxItems`, no stored conversation at all) offers
  no Archive action — running it used to silently no-op while still toasting
  "Archived.".
- **Archived ⋯ is Restore + Delete** for email and SMS (SMS hard-delete is
  `DELETE /api/manager/sms-conversations`). Active ⋯ stays Archive only. PropLane
  Assistant cannot be archived or deleted. Archived has a **Delete all archived**
  button (`unified-inbox-delete-all-archived`) that confirms, then deletes every
  non-assistant conversation; it is hidden when only Assistant remains.
- **An opening conversation shows `InboxThreadSkeleton`**, never "Select a
  conversation" / "select a message", while the routed or clicked thread is still
  resolving. Composer stays pinned (`shrink-0`, pane `scrollTop` — never
  `scrollIntoView`) including on archived SMS threads.
- **A conversation clicked on Unread keeps its pane after it is read.** The row
  leaves the list, the thread stays open. That retention lives in
  `explicitlyOpened` and is decided in the selection effect's own body from the
  committed `selectedKey` — never inside a `setSelectedKey` updater, which React
  runs in the render phase and may re-base from an older base state, dropping
  the retention of the row just clicked. Coverage:
  `tests/unit/unified-conversation-inbox.test.tsx`.
- **Initial Communication membership reveals only after every enabled source succeeds.**
  Manager readiness requires inbox threads, applications/contact-directory rows,
  and SMS when its UI is enabled. Resident readiness requires inbox threads and
  enabled SMS. A successful empty response is ready; a failed or malformed response
  is an error with Retry. Published rows, optimistic SMS contacts, request status,
  and SMS authorization-stop latches stay scoped to the current viewer generation,
  so a retained component cannot carry them across an account change. Background
  refresh failures preserve an already usable list. Coverage:
  `tests/unit/inbox-initial-loading-readiness.test.tsx`.
- **Scheduled messages sit in a bar under the conversation name**, above the
  messages (`InboxScheduledThreadList` `placement="bar"` on `InboxThreadView`'s
  `underHeader`). Each row is clock · kind · subject · time — no send
  icon; a row's only job is to open its detail pop-up. That pop-up carries one
  footer: **Cancel send** on the left (danger, behind a confirm) and **Send now**
  · **Save** on the right, with no inner close X. Cancel send and Send now
  render only while the message is still pending — a surface that can open a
  sent, cancelled or failed row passes `scheduled={false}` so a destructive
  confirm never fronts a no-op (the Schedule panel and the payment-reminder
  pop-up both do). `showSendActions={false}` hides both (tour reminders);
  resident views pass no `onSendNow`, so they get Cancel send only. The subject,
  body, send time and In-app/Email/Text choices save through `onSaveEdit`; an unchanged channel choice emits no override.
  In-app is persisted as `deliverViaInbox` for manual sends and
  `customDeliverViaInbox` for payment-reminder overrides. Bar selection uses
  message identity, so removal of an earlier row never changes the editor. The
  standalone Schedule table is gone from production. Matching is pure:
  `scheduledItemsForRecipient(email, manual, automation)` in
  `src/lib/inbox-scheduled-thread.ts`. Edit permissions are unchanged —
  resident-originated / resident-side rows are cancel-only (the resident
  scheduled-message route only patches status), so residents pass no `onSaveEdit`.
  `onSaveEdit` MUST reject on failure (see `saveScheduledEdit` in
  `manager-inbox.tsx`) — the card keeps the editor open and shows the error
  instead of closing and discarding the manager's text.
  **Admin is inline too.** The old Scheduled view (and its
  `admin-inbox-scheduled-toggle` button) is gone. A pending send renders in the bar
  of its recipient's conversation (`useThreadScheduledCards` over
  `/api/portal/scheduled-inbox-messages`), and a send to someone admin has never
  messaged is drawn as a conversation of its own (`adminScheduledStubThread`,
  `src/lib/admin-inbox-threads.ts`) so it still has a thread to sit in and a
  reachable Cancel. Admin passes `includeAutomation: false` - it has no payment
  reminders and must not issue the manager-only `scheduled-messages` read. Keep the
  admin compose's "Schedule for later" and recipient picker
  (`admin-compose-modal.tsx`) working with it: a scheduled send must never become
  uncancellable.
- **`scheduled-message-path-id.ts` must NEVER use the `base64url` encoding
  token.** It runs client-side (building the scheduled-message action URL), and
  Next's browser Buffer polyfill throws "Unknown encoding: base64url" — that
  crashed Send now / Cancel / Edit on automation messages. Use btoa/atob + the
  `base64` transform only (`tests/unit/scheduled-message-path-id.test.ts` guards
  this with a throwing-Buffer shim).
- **One person is ONE conversation, across channels** (and, since comms-safety-0929, one per workspace — see "One conversation per person per workspace — the conversation key" below; the rows now also join on the shared conversation key, the email `personKey` below is the older, narrower join). `mergeUnifiedInboxItems`
  (`src/lib/unified-inbox-merge.ts`) groups list rows on a `personKey` — the
  counterparty's lowercased email — so a resident's email thread and their text
  thread collapse into a single row instead of appearing twice. The newest
  contributing row supplies preview / stamp / sort position and decides which
  thread the row opens; the row is unread if ANY channel is; `channels` drives
  the "Email · SMS" badge; and `memberKeys` carries every folded key, which is
  what selection and any destructive action must cover — an SMS delete is an
  irreversible hard delete, and scoping it to the winner alone would leave the
  other half stored and still rendering.
  **A row with no `personKey` NEVER merges.** An unknown texter has no resolved
  address, and guessing their number onto a resident would show a stranger's
  messages — and the manager's replies — to the wrong person. Linking happens
  the honest way, by saving a phone contact, which is an address-book write.
  A merged conversation renders through `ResidentDirectChatPane`, which already
  speaks both channels for one person; its timeline interleaves email and SMS
  bubbles, reducing BOTH sides to milliseconds with `parseInboxStampMs` (the
  canonical inbox stamp carries no year and is Pacific — a bare `Date.parse`
  on it let an older email outrank a newer text). Channel tags are decided by
  `buildInboxMessageTimeline`, which tags only when the thread truly spans
  channels, so single-channel threads stay untagged with no flag to keep in
  sync. Coverage: `tests/unit/unified-inbox-person-merge.test.ts`.
- **Resident and manager views of one property conversation use distinct global
  row ids.** `portal_inbox_thread_records.id` is globally unique, so the
  resident side keeps the legacy `property_mgr_*` id used by tour links and the
  manager side uses its side-qualified id. Before creating either row, reuse a
  compatible scoped person thread only when owner, counterparty email, role,
  manager, and property metadata do not conflict. New rows use `insert`, never
  `upsert`: a concurrent or incompatible id collision must fail without
  replacing the row that won. Existing-row updates must surface persistence
  errors. Resident compose also carries one UUID operation id across an
  unchanged failed draft. The server binds it to the authenticated sender,
  derives distinct per-side message ids, and skips a turn already recorded on
  retry; reusing the id with changed content fails. This makes a resident-side
  success followed by a manager-side failure safe to retry without duplicating
  the first side. Coverage: `tests/unit/property-manager-inbox-thread.test.ts`.
- **Messages are Slack-style rows, and who sent a turn is its name.** Every turn
  (the viewer's, a counterparty's, the assistant's) is a left-aligned row: a 32px
  tile, the author's name (14px/650) with the clock beside it, the text at 14px,
  and a quiet 11.5px "via" line (phone or mail glyph) where the thread spans
  channels. A run of turns from one sender shows the tile and name once; day
  separators are hairline rules with the label between. There are no filled or
  side-pinned bubbles. `data-inbox-bubble-align` stays `end` for the viewer's own
  turns (and for assistant notices in a person thread) and `start` for everyone
  else, so tests and tooling can still tell the sides apart; `data-inbox-bubble-kind`
  carries `inbound | outbound | assistant | system`. Assistant-authored turns show
  "PropLane" with a sparkle tile and the clock - never an "Assistant" / "PropLane
  Assistant" label. List previews do not prefix assistant turns with "You: ".
  Coverage: `tests/unit/inbox-turn-direction.test.ts`,
  `tests/unit/inbox-bubble-alignment.test.tsx`.
- **Thread messages are channel-tagged** (`InboxBubbleMessage.channel`,
  `InboxChannel = email|sms|whatsapp|gmail`). Manager email and SMS are live in
  one selected person pane. Each explicitly bound SMS projection loads its own
  paged transcript; a list preview is never treated as history. Bubbles render
  the full body (pre-wrap, no clamp).
- **SMS compose is gated by `isSmsCommUiEnabled()`** (`src/lib/sms-comm-ui-flag.server.ts`,
  env `SMS_COMM_UI_ENABLED`, default OFF, server-resolved). `render-portal-section.tsx`
  threads it as the `smsUiEnabled` prop into all four Communication components
  (manager / resident / vendor / admin). For manager Communication, the flag
  controls SMS compose and chrome; authorized projected history and unresolved
  compatibility notices remain visible in both states. The server removes only
  exact original notice turns whose replacement is visible to that viewer.
  Other portals keep their existing flag behavior. SMS transport, both SMS
  agents, and phone provisioning stay live. Coverage:
  `tests/unit/unified-conversation-inbox.test.tsx`,
  `tests/unit/resident-conversation-inbox.test.tsx`,
  `tests/unit/vendor-conversation-inbox.test.tsx`,
  `tests/unit/portal-nav-communication-count.test.tsx`,
  `tests/unit/inbox-scheduled-thread.test.ts`,
  `tests/unit/inbox-thread-omnichannel.test.tsx`,
  `tests/unit/sms-comm-ui-flag.test.ts`.
- **A resident schedules from the thread composer, never from New message** —
  the reply composer carries the same clock tool as the manager's
  (`InboxComposerScheduleMenu` in `resident-inbox-panel`), while
  the shared New message composer drops its schedule control for
  `portal === "resident"` (`roleComposeCapabilities` in `src/lib/role-compose.ts`).
  Scheduled rows stay cancel-only (no inline
  edit). The resident thread composer has no assistant strip or AI draft (the
  Ask PropLane pill in the top bar is the resident assistant, see
  [`../ai-assistant.md`](../ai-assistant.md)); `hideAssistantFab` on
  `PortalCommunicationShell` is what keeps the FAB and in-thread strip off a
  manager's resident-detail Communication tab.
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
- **Communication is decided per HOUSE and per WORKSPACE by ONE resolver:
  `src/lib/communication/conversation-visibility.server.ts`.** Email threads,
  SMS conversations, the houses picker, reply / send, mark-read, archive,
  delete and the assistant's inbox tools all ask `conversationVisible`. Three
  rules, in order: (1) a PropLane Assistant thread (`agent_notice`) belongs to
  ONE manager in ONE workspace — co-managers in the same workspace each have
  their own chat, another workspace has a new chat, and the viewer never sees
  anyone else's. Legacy `agent_notice_{userId}` is the default workspace's
  chat; other workspaces use `agent_notice_{userId}__{workspaceId}`. The row
  is pinned on Active and Unread — never Archived, where it is not selectable
  and does not count towards the Archived badge — and cannot be archived away
  (`pro-unified-inbox.tsx`'s `mergedRows` / `listSegmentCounts` skip pinning it
  when the segment is `"archived"`; `withPinnedPropLaneAssistantThreads`
  itself still accepts a `listSegment` of `"archived"` for callers that build
  the row set before this same filtering, e.g. its own unit tests). If
  they ask about a house that lives in another workspace, the assistant
  replies exactly "Please switch to the other workspace for these questions."
  (2) sharing is per house — a co-manager sees another owner's
  conversation only when it is about a house they hold Communication on at the
  level asked for (`read` lists, `edit` replies and sends, `delete` deletes),
  and a conversation about no house is never shared; (3) the active workspace
  narrows — a conversation shows in the workspace that holds its house; a
  house-less thread follows the work line it used (the owning workspace's SMS
  number or assistant address — shared-in number assignments do not duplicate
  threads), and only when no line places it does it fall back to the owner's
  default workspace. Manager email inbox sync is server-authoritative on fetch:
  rows the API omits are dropped from local storage (local-only ghosts do not
  resurrect). New SMS projection archive/read state is per viewer with a
  compare-and-set version; legacy archive flags still mirror from
  `manager_tour_followup_controls`. The SMS reader cache keys on workspace so a
  switch refetches. A conversation's house:
  SMS uses `houses[]` (conversation-houses tags, else residency); email uses
  the stamped `row_data.propertyId`, else the counterparty's applications and
  residency with that owner (`emailThreadHouses`, every house kept). Owner
  scope in the store query only pre-narrows; it is never the answer. Every
  lookup degrades safely: a failed grant read shares nothing, a failed
  workspace read narrows nothing. **A manager's inbox never includes another
  owner's thread just because the manager is the person it was sent to** —
  the `participant_email` clause covers legacy owner-less rows only
  (`participantOnlyWhenUnowned`). Coverage:
  `tests/unit/communication-visibility.test.ts`,
  `tests/unit/portal-inbox-thread-scope.test.ts`,
  `tests/unit/portal-inbox-thread-reply.test.ts`.
- **The manager↔manager Team thread is server-owned and shared.** WS5 added
  exactly one new `portal_inbox_thread_records` kind, `thread_type: "team"`
  (`team-thread:<owner>[:<propertyId>]`, `src/lib/team-comms.server.ts`) —
  one per owning account per house, plus a house-less one for the owner
  alone. It is where every `team`-audience action event posts (owner:
  [`automated-communication.md`](automated-communication.md)). It reads and
  replies through the same house rules as rule (2) above: `inbox` on the
  house at `read` lists it, `edit` posts to it, and the send route
  re-derives membership from the thread id itself (`assertTeamThreadMember`)
  before `postTeamThreadMessage` appends under a CAS on `updated_at` and
  mirrors the post to SMS. A reply is an in-app post (no person
  counterparty — `isTeamInboxThread` treats it like an assistant thread).
  The browser's wholesale `replace` never carries a team thread and
  `/api/portal-inbox-threads` merges only mailbox state (read / archive /
  resolved drafts) for one, so a stale snapshot can never overwrite turns
  others posted. Coverage: `tests/unit/team-comms.test.ts`,
  `tests/unit/action-events-team-audience.test.ts`.
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

## One conversation per person per workspace — the conversation key

**Captain-approved (comms-safety-0929, D1 + D2).** A person is ONE conversation
in a workspace, however they reached you: in-app messages, email, texts, a
per-property chat, a tour or welcome notice, a co-signer notice. Different
workspaces never share a conversation, even for the same person.

**The key** is decided by ONE resolver, `src/lib/communication/conversation-key.server.ts`
(pure rules in `conversation-key.ts`, table-tested in `tests/unit/conversation-key.test.ts`):

| Key | Who |
| --- | --- |
| `acct:<uuid>` | an account (resident / vendor) **linked to this workspace** by a lease, an application or a vendor record |
| `tel:+15105551234` | a phone, strict E.164 (`normalizeE164` is the only phone normalizer; the other six route through it) |
| `mail:<email>` | an email, lower-cased |
| `ws:<workspace uuid>` | on the resident / vendor side of the same conversation: the manager workspace they are talking to |

Precedence is account → **verified** phone → email. A phone links to an account
only if that account verified it (`profiles.phone_verified_at`); an unverified
phone never links anyone. If two accounts in the workspace verified the same
number, **nothing merges**: the conversation keeps its phone key and carries
`identityFlag: { reason: "ambiguous_phone", accountIds }` for the manager to
choose. A phone and an email on one record are never fused without an account
vouching for both. A thread stored under a weaker key (`mail:`) is found and
upgraded in place when the person later gains an account link.

**Storage.** `portal_inbox_thread_records.conversation_key` + `workspace_id`
(migration `20261003180000_one_conversation_per_person.sql`, additive). A unique
index on `(owner_user_id, workspace_id, scope, conversation_key)` allows one row
per person per workspace per inbox. The only way a person-thread is created is
the `resolve_or_create_conversation` RPC (service role only): it takes an
advisory lock on (owner, workspace), returns the existing row for any of the
person's keys, else inserts — so two simultaneous sends make ONE conversation
(`created: false` → the loser appends to the winner). `adopt_conversation` stamps
a legacy row; `portal_inbox_thread_aliases` keeps every folded thread id
resolving (tour links, deep links; `resolveInboxThreadReplyTarget` follows an
alias). The same key is stamped on `sms_projection_conversations`, which is how a
text and an in-app message join in the list (`joinKeys` in `unified-inbox-merge.ts`;
`ck:<workspace>:<key>`). Vendor / third-party inboxes with no manager workspace
use `PERSONAL_WORKSPACE_ID` (the nil uuid). Admin and Assistant / team / agent
threads carry no key. **Before the migration is applied** the writers notice the
missing column once and keep the legacy per-email behaviour
(`conversation-thread.server.ts`), so a deploy never fails a send.

**Every writer goes through `deliverPortalMessageThreadSide`** (or the property
chat's `resolvePropertyManagerThread`): `portal-inbox-delivery.ts`,
`property-manager-inbox-thread.server.ts`, `tour-notification-delivery.server.ts`,
`resident-welcome.server.ts`, `cosigner-notification.server.ts`,
`inbound-email-reply.server.ts`, `vendor-work-identity-inbound.server.ts`,
`mirror-assistant-email-conversation.server.ts`, `admin-shared-inbox.server.ts`.
`sms-inbox-notice.server.ts` keeps its compatibility row (its id, archive
controls and source markers are phone-keyed) but carries the SAME key in
`row_data`, and the SMS projection stamps it on the summary. A turn carries its
`houseId` / `houseLabel`; the conversation row no longer claims one house.

**Reply check.** `send-inbox-message` refuses (409) a reply whose thread is not
the recipient's conversation (`replyRecipientsMatchThread`): keyed person thread
→ the recipient must resolve to that key in that workspace; `ws:` thread → the
recipient must belong to that workspace; a legacy thread → its stored email.
The reply used to be storable in one conversation and delivered to another.

**D2 — what a co-manager sees.** A co-manager granted only some houses opens the
merged conversation and sees only the turns about their houses; a turn with no
house shows only to a viewer who holds EVERY house of that person
(`restrictThreadToHouses`, applied in `filterVisibleInboxThreadRecords`; a
conversation with nothing left is dropped, `housesRestricted` marks the rest).
SMS turns carry no house, so an SMS conversation is shared with another owner's
co-manager only when they hold every house of it (`untaggedTurns` in
`conversationVisible`). This closes S9; S7 is closed because the assistant-email
mirror files the thread under the address's workspace and stamps `row_data.workLine`.

**UI.** One row per conversation (`mergeUnifiedInboxItems` joins on shared
`joinKeys` as well as the email `personKey`; a flagged row joins only on its own
key); a channel glyph on each turn's tag; a house tag on a turn only when the open
conversation spans houses; the row's house label reads "4709A 8th Ave +1" when
it does; the resident / vendor list shows one row per manager workspace and the
text stream folds into it when there is exactly one workspace. The reply-channel
control is the existing In-app · Email · Text selector.

**Backfill.** `scripts/merge-conversations-backfill.mjs` (`npm run
comms:merge-conversations`): dry run by default, prints every merge (keys
redacted), resumable by owner (`--cursor-file`), requires two consecutive empty
plans after `--apply`, keeps absorbed ids as aliases, never merges an ambiguous
or unresolved identity, and refuses any project but dev without `--allow-project`.
The planner is `conversation-backfill.ts` (`tests/unit/conversation-backfill.test.ts`).

Coverage: `tests/unit/conversation-key.test.ts`, `one-conversation-per-person.test.ts`
(incl. the concurrent-create contract and the unapplied-migration fallback),
`reply-thread-key-check.test.ts`, `conversation-house-visibility.test.ts`,
`conversation-backfill.test.ts`.

## A resident's texts are in their conversation (C1-R4)

A resident has ONE conversation per manager workspace (`ws:<workspace>`); their
texts to that manager's work number are in it, with the in-app and email turns.
`src/lib/communication/resident-conversations.server.ts` reads them, the pure rules
are `resident-conversation.ts` (`tests/unit/resident-conversation.test.ts`):

- A text conversation is a resident's only via the account the SMS pipeline
  resolved (`counterparty_user_id`) or a phone **they verified**
  (`profiles.phone_verified_at`, `decideResidentSmsLink`). An unverified phone
  never links; if another account verified the same number nothing links by phone
  (the response says `residentPhone.ambiguous`); another account's, manager,
  admin, vendor and unresolved conversations never appear. The PropLane
  Assistant thread has no manager and no texts.
- The workspace is the **work line's** (`manager_sms_numbers.workspace_id`), never
  a summary's stamp, so a mis-stamped row cannot cross workspaces. Texting two
  managers is two conversations.
- The texts are derived per GET (`applyResidentConversationExtras`), never stored
  on a resident row: ids `sms-proj:<turn>` are in `shared-thread-merge`'s derived
  set so a save never persists them, and a text-only conversation is a read-only
  row `resident_sms_<workspace>` (`smsOnly`, reserved id, no email).
- Every workspace-keyed resident row carries a server-stamped `counterparty`
  (`name`, `workspaceName`, `workPhone`, `initials`; no avatar column exists
  today). A body's `counterparty` / `smsOnly` is discarded.
- A Gmail from a resident's account email to the work address is also written
  into THEIR conversation (`mirrorAssistantEmailConversation` `residentUserId`,
  only for a sender classified as that manager's resident); the assistant's
  answer is not copied.
- Verifying a phone (`PUT /api/manager/phone`) calls `linkVerifiedPhoneHistory`,
  which re-keys the number's past SMS projection rows through the one resolver
  (`acct:` where the resident is linked to the workspace, else the `tel:` key).

## A reply leaves on the channel the person reached you on

Person threads in Communication default the composer to the **last inbound
channel** (`lastInboundChannelOf` in `src/lib/portal-inbox-storage.ts` →
`resolveCommunicationPersonThreadReplyChannels`): an email to the work address
is answered by email (from the workspace work address, subject `Re: <subject>`),
a text by text, a portal message in-app. A thread with no stamped inbound keeps
the in-app default. The old in-app-only default let a manager answer a prospect
who had only ever emailed — the reply landed on a row nobody could read.

### The composer's channel: last inbound, sticky, honest (screen J, Oct 8)

- **Inbound SMS notices are stamped.** `upsertManagerInboxNotice` writes
  `rootChannel: "sms"` on the root and `channel: "sms"` on every appended turn, and
  `append_manager_sms_inbox_notice` (migration `20261008230000_sms_notice_channel_stamp.sql`)
  stamps the same server-side when a caller names none. Rows stored before the stamp are read as
  text by `lastInboundChannelOf` from `threadType` (`claw_leasing_sms` / `claw_resident_sms`) or
  `smsNoticePhone`, the way it already special-cases `assistant-email-` rows. Inbound **email** was
  always stamped (`mirrorAssistantEmailConversation`, `channel: "email"`).
- **The default is the last inbound channel and it is sticky per thread.** `resolveStickyReplyChannels`
  (`manager-inbox-reply-channels.ts`): a manual channel pick is remembered for the thread against the
  inbound channel it was made under (`ReplyChannelMemory` in `pro-inbox.tsx`); only a NEW inbound on a
  different channel, or a remembered channel that stopped being available, returns to the default.
- **In-app is offered only to people who can read it.** `inboxThreadPortalReachable` =
  `resolveManagerInboxPortalRecipient` non-null (an email, or an SMS contact tied to an account), or an
  assistant/team thread. `activeProplaneAvailable` is that, no longer `Boolean(activeThread)`. A phone-only
  prospect gets Text; an unreachable In-app is never selected, so it can never be auto-sent.
- **A refused send never loops.** The AI-draft auto-send latch is per draft + channel choice and is KEPT
  when the send is refused (only a "nothing attempted" result clears it); the toast is deduped per draft +
  channel; the retry is a user action (Approve, or picking another channel).
- **The server answers on the inbound channel, so the browser does not.** See
  [`inbox-ai-drafts.md`](inbox-ai-drafts.md) § Server auto-reply. A text to the work number is answered by
  the prospect/resident SMS agent and the reply is recorded on the notice thread as a sent turn
  (`recordAutoReplyOnSmsNotice`); `threadEligibleForAiDraft` and `/api/portal/inbox-draft-reply` skip
  `claw_leasing_sms` / `claw_resident_sms` threads (`isServerAgentAnsweredSmsThread`).
- Tests: `tests/unit/sms-notice-channel-stamp.test.ts`, `manager-inbox-reply-channel-default.test.ts`,
  `manager-inbox-auto-send-refusal.test.tsx`.

Every turn is **stamped with the channel it actually went on**
(`InboxThreadMessage.channel`: `email` / `sms` / `proplane`; the root turn's stamp
lives at `rootChannel`). The bubble shows that tag and nothing else — an
unstamped legacy turn shows no tag, never a guessed "Email". Email turns also
carry their `subject`; the manager bubble builder shows it once per topic
(`subjectTopic` folds `Re:`/`Fwd:`), so "Re: Propert" is not repeated on every reply.

Inbound email bodies are quote-stripped by `stripEmailReplyQuote`
(`src/lib/inbound-email/inbound-email-reply.server.ts`), which understands the
Gmail attribution header that wraps onto a second line — the one case that used
to leak "On … wrote:" into the bubble. Coverage:
`tests/unit/inbound-email-reply.test.ts`, `tests/unit/assistant-email-mirror-stamps.test.ts`,
`tests/unit/manager-inbox-reply-channels.test.ts`, `tests/unit/inbox-bubble-alignment.test.tsx`.

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
- **The bucket has a second writer that is not a message attachment.** Inspection
  chat/MMS intake stores private photo sources here as
  `<userId>/inspection-chat/<ownerId|portal>/<sha256>.jpg`; they are never listed
  on a thread and are filed into a report only through the confirm-gated
  `file_inspection_photo`. Ownership still reads `path[0]`. Rules live in
  `docs/agents/inspections.md` — count this writer in when changing the bucket's
  configuration below.
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

## A message that asks for something files it (PRP-109)

**"Is this message a request?" has exactly ONE answer:
`classifyInboundMessage` (`src/lib/inbox/inbound-message-intent.ts`).** Three
copies of that judgement existed before — the manager inbox chips, the live SMS
gate `looksLikeMaintenanceRequest`, and a third in the chip module — so the same
sentence could open a work order over SMS and produce nothing in the portal.
`looksLikeMaintenanceRequest` and `suggestInboundMessageWorkflows` now both
delegate to it. **Do not add a fourth**; tune the shared one.

It is deliberately a pure, deterministic classifier, not a model: it runs on
every inbound message across three channels, resident text is untrusted input
(a regex cannot be prompt-injected), and it is table-testable. The signature is
model-shaped, so swapping the internals later does not touch a caller.

Its shape matters, because a plain keyword match filed **real** work orders on:

- **already-resolved messages** — "the toilet leak is fixed, thanks" still
  contains "leak" and "toilet". `RESOLVED_MARKERS` is checked FIRST and vetoes
  outright, before any scoring.
- **ambiguous words in an unrelated sense** — "can we fix a time to meet?",
  "I'm locked out of my account". Eligibility is structural, not a score: a
  self-sufficient phrase ("leaking", "no hot water", "not working") stands
  alone, otherwise it takes a failure word NAMING a fixture ("toilet …
  broken"). "Fix" names no fixture; "the sink" names no failure. A request
  marker raises confidence but never creates eligibility, and only an eligible
  side may win — comparing raw scores handed every add-on ask to maintenance.

**Filing goes through one seam**, `fileWorkflowFromInboundMessage`
(`src/lib/inbox/inbound-message-workflows.server.ts`), which dispatches to the
existing `createWorkOrderFromResidentSms` / `createServiceRequestFromResidentSms`
— those own the dedupe (near-identical text from one resident inside a short
window is a no-op) and the manager notification. Rules for adding a channel:

- **Call it AFTER the message is persisted, inside `after()`.** Filing is
  best-effort and must never fail a send or make a webhook retry a message that
  already landed. The seam swallows every error and reports it in its return.
- **Identity comes from the authorized caller, never the body.** `managerUserId`
  and `residentEmail` come from the session and the thread the route already
  authorized. Nothing reads an id or address out of the message text.
- **Inbound email verifies the DIRECTION** (`fileWorkflowFromInboundEmailReply`).
  A portal reply token names whoever sent the ORIGINAL mail, which is sometimes
  the manager and sometimes the resident, so filing on the token alone would
  open a work order against a manager's own reply as if they were a tenant.
  `managerIdsOwningResident` must confirm the replier is that owner's resident;
  anything else, a failed read included, files nothing. It also runs the cheap
  classifier BEFORE that read, so an ordinary "sounds good, thanks" costs no
  query. Only a genuine first append files — a Resend redelivery must not open
  a second work order.

Coverage: `tests/unit/inbound-message-intent.test.ts` (the classification table
is the spec), `tests/unit/inbound-message-workflows.test.ts`.

**`loadManagerSmsConversationsClient` (`src/lib/manager-sms-conversations-client.ts`)
now has a TTL, not just in-flight coalescing.** `createCoalescedRefresher`
only dedupes CONCURRENT callers; it holds no cache of the settled result, so
an unforced caller arriving after the previous fetch already resolved used to
start a brand-new request regardless of how recently that was — the sidebar's
60s nav-count poll plus the inbox/composer reading the same directory made
`/api/manager/sms-conversations` one of the slowest calls on most manager
routes. A 20s TTL now sits in front of the refresher; `force: true` (e.g.
after a send/delete) still always starts a fresh fetch. Any new caller should
go through this client rather than calling the route directly.

## A vendor's texts are in their conversation (Oct 6)

The vendor equivalent of the resident rule above. A vendor holds ONE conversation
per manager workspace (`ws:<workspace>`); a manager's texts with the vendor's phone
appear in it, with the in-app turns. `communication/vendor-conversations.server.ts`
reads them (it shares the placement code with the resident loader), the pure rule is
`communication/vendor-conversation.ts` (`decideVendorSmsLink`), tests are
`tests/unit/vendor-conversation.test.ts`:

- a text conversation is a vendor's only via the account the pipeline resolved
  (`counterparty_user_id`) or a phone **they verified by code**
  (`profiles.phone_verified_at`). `vendor_business_profiles.work_phone` and an
  unverified `profiles.phone` link nothing;
- a number two accounts verified links to **neither**;
- only `vendor` conversations; the workspace is the work line's own (work line +
  epoch), a line that cannot be placed is dropped;
- verifying a phone (`PUT /api/manager/phone`, role from `profile_roles`) calls
  `linkVerifiedVendorPhoneHistory`: a roster row links (`vendor_user_id`) ONLY when
  its own saved phone equals the verified phone and is not already linked, and the
  vendor's conversations are re-keyed through the one resolver;
- `GET /api/portal-inbox-threads?scope=vendor` folds the texts in
  (`applyVendorConversationExtras`); linked history is **not** behind
  `SMS_COMM_UI_ENABLED` (that flag hides the manager's text compose). A text-only
  conversation is a derived `vendor_sms_<workspace>` row (`smsOnly`, never client
  created): the vendor replies by text to that manager's work number, or starts an
  in-app message with New message, after which both are one row.
- `/api/vendor/sms-conversations` returns the same conversations (one per
  workspace) and falls back to the job assistant's SMS turns only when nothing is linked.

## Work identity disclosure

Public listing contacts, preview contacts, resident manager cards, manager thread contact details, and new flyer defaults use the relevant workspace work number and work email. Personal profile phone/email and the retired sharing opt-in never provide fallback contact values. `resident-manager-contact.server.ts` and the authorized `/api/manager/work-contact` relationship read enforce this server-side.

**Send identity (Oct 3).** Once a workspace has a work number, every message PropLane sends for it leaves through the workspace work identity: SMS from the work number (the owner dispatcher derives the line; a caller `fromNumber` is never send authority), email from the workspace work email (`managerOutboundFromHeader` / `resolveManagerOutboundFrom`, with `{ propertyId }` selecting the house's workspace), in-app as the manager. There is no personal-sender choice and a request asking for one is ignored (`src/lib/workspace-send-identity.ts`; `tests/unit/workspace-send-identity.test.ts` classifies every direct `RESEND_FROM` reader). The sender address is the authenticated account's, never a request-body field. Settings -> Communication carries no personal mobile row.

## Bookings: notices and removed stays (C2-BK4, C2-AB7)

Cancel booking's "Notify guest" sends through the same authorized `POST /api/portal/send-inbox-message` (`booking-cancel-notice.ts`), after the cancel is saved, stamped with a `booking` recordRef; with no email on the stay the checkbox is disabled. A stay brought in by a channel feed is removed with a tombstone (`channel_stay_tombstone` in `portal_schedule_records`, keyed by house, room, channel and the feed's event UID) written by `/api/portal/channel-calendar/stay-tombstones`; the sync prunes tombstoned UIDs before it stores ranges, and Undo restores the carried range. Notes and stay details on a signed-lease or application stay (`booking_stay_meta`) are written by `/api/portal/bookings/stay-meta`, which re-derives the caller's access to the lease/application from the session. The generic schedule-records route refuses both record types.
