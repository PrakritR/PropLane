# One-number SMS: implementation map

Spec: [`one-number-spec.md`](one-number-spec.md). Shared contracts: `src/lib/one-number/contracts.ts`.
Each workstream owns one section below.

## W2 - Shared-line transport, MMS, redaction, workspace stamps

**Line mode** lives on `sms_runtime_config` (`line_mode`, `shared_number_e164`,
`shared_messaging_service_sid`, `shared_pilot_workspace_ids`). Transport reads it with
`readSharedLineConfig` (`src/lib/one-number/shared-line-number.server.ts`), which is tolerant:
any error or a missing column/table (42P01, 42703, PGRST204/205) reads as `per_workspace`, so
nothing changes until the switch is flipped. Only `shared` sends from the shared number;
`shadow` never does. `shared_pilot_workspace_ids` empty = every workspace.

**Send path (one door, same outbox).**
- `sendSharedLineMessage` (`send.server.ts`) -> `sendFromManagerWorkNumber` -> `enqueueOwnerSms`
  -> `dispatchOwnerSmsOutbox`. Consent, quiet hours, protected-account shield, test capture,
  workspace wallet reservation and delivery status are the work-number path's own.
- `evaluateWorkspaceSendReadiness` has a shared-line branch (`viaSharedLine`): runtime kill
  switch + owner allowlist still apply, consent stays scoped to the deployment's
  `TWILIO_MESSAGING_SERVICE_SID`, billing is the stamped workspace's wallet. The provider call
  uses the shared Messaging Service (`providerMessagingServiceSid`).
- `sendSms` (`src/lib/twilio.ts`) accepts the configured shared number as a `from` (no fake
  `manager_sms_numbers` row) but still demands a reserved, matching credit hold.
- The pre-submission recheck also runs for shared sends and compares From + workspaceId.
- Human replies from the inbox (`manager-sms-send.server.ts`, `/api/portal/send-inbox-message`)
  on the shared line carry "<house or workspace name> team" (`resolveSharedLineHumanSend`,
  `appendSignOff`). The sign-off uses a plain hyphen: a long dash would make the text UCS-2.

**Workspace stamps.** `workspace_id` is written on `sms_outbox` (enqueue), `manager_sms_messages`,
`inbound_sms_log`, `manager_sms_contacts` through `withWorkspaceStamp`
(`workspace-stamp.ts`), which retries without the column when it is not migrated. DB triggers
stamp `sms_inbound_receipts` (from the claim payload's `workspaceId`) and `sms_projection_turns`
(from the conversation). No read changed.

**Conversation identity on the shared line.** There is no `manager_sms_numbers` row for the
shared number, so a shared-line conversation lives on a synthetic work line whose id IS the
workspace id (`resolveSmsProjectionWorkLine({ workspaceId })`). It is projected by
`project_shared_line_event` (migration `20261018110000_one_number_transport.sql`; the
work-number RPC is untouched), keyed (owner, role, workspace, identity) with
`line_kind = 'shared'` and a partial unique index on the stamped workspace. The same phone in
two workspaces of one owner is two conversations. Readers that join `work_line_id` to
`manager_sms_numbers` will not find a row for these; resolve a shared line by `line_kind`.

**MMS (every role).** `ingestInboundMedia` (`inbound-media.server.ts`), called from
`processClaimedInbound` right after the receipt is logged, downloads each item with the
validated Twilio fetch (`fetchTwilioMessageMedia`), stores it in the private `sms-media` bucket
(`manager/<owner>/<sid>/<n>.<ext>`) and indexes it in `sms_media_files`. Idempotent per
(message_sid, media_index). Links: resident maintenance -> `work_order` (photos in the last 30
min are put on `row_data.photoDataUrls` and linked in `createWorkOrderFromResidentSms`); vendor
on an open job -> `vendor_job` (+ `completionPhotoDataUrls`); prospect/manager unlinked. The
inspection photo intake is unchanged. Bubbles show images inline (`SmsMediaImages`); the read
URL is `/api/sms-media` -> a signed URL with `download: true` (never inline); the route lets the
owner and accepted team members of the file's workspace in, and fails closed otherwise.

**Redaction.** `/api/twilio/inbound` replaces Luhn-valid card numbers and bank/routing numbers
with `[redacted]` (`redact.ts`) before the receipt, projection, inbound log or any agent sees the
body, and flags the receipt payload `redacted: true`. The reply for such an inbound is replaced
with the secure-link notice in every agent deliverer (`redactedInboundReplyOverride`).

**Segment guard.** `toGsm7` / `smsSegmentCount` (`segments.ts`) run in the manager, resident,
leasing and vendor agent reply deliverers and in `sendSharedLineMessage`. Text that is already
GSM-7 is returned unchanged.
