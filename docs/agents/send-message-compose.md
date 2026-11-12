# Send compose — New message is the one send UI

Read this before adding or changing any surface that **sends a message**
(invite, reminder, listing share, payment notice, vendor ping, accept-page
reply). This file is the standing rule. The inbox list rules stay in
[`communication-inbox.md`](communication-inbox.md).

## Dominant chrome

**Every send looks like Communication → New message.** Do not invent a second
compose. Title may change (`New message`, `Send invite`) — the field order,
spacing, and controls do not.

```
Title                         Ask PropLane    ×
To            [ recipient dropdown / locked name ]
Communication type [ PropLane · Email · SMS ]
Subject       [ text ]
Message       [ textarea ]
☐ Schedule for later
                              [ Send email | Send SMS | Send message | Schedule ]
```

Use the existing primitives — do not restyle them:

- `ManagerCommunicationComposeModal` / `PortalNotificationPreviewModal`
- `portal-message-compose-fields.tsx` (`PortalMessageRecipientLockedField`,
  `PortalMessageSubjectField`, `PortalMessageSendViaDropdown`,
  `PortalMessageBodyField`, `PortalMessageScheduleFields`,
  `PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS`, `portalMessageConfirmSendLabel`)

Forbidden:

- A stacked “Invite by email” / “Create invite link” card as the send step
- Helper sentences under Subject / Send via / Message
- A footnote under Send via (PRP-452)
- A one-off email-only form that skips To / Subject / Send via / Message /
  Schedule for later

Invite **methods** (link / message / PropLane code) are tabs on the step
*before* this chrome, for the **vendor invite modal only**
(`pro-vendor-form-modal.tsx`); they are not a second compose. The manager
workspace invite has no such chooser — see the next section.

## One New message composer for every role

`ManagerCommunicationComposeModal` (`pro-communication-compose-modal.tsx`) is the
New message UI for managers, vendors and residents. A vendor or resident panel
mounts it with `portal="vendor" | "resident"`, its own `liveContacts` (the scoped
list that role may message today, no fetch of the manager directory) and its own
`onSend`. The older `ScopedInboxComposeModal` is deleted; do not bring back a
second window. What differs per role lives in one place,
`roleComposeCapabilities` in `src/lib/role-compose.ts`:

| | Manager | Vendor | Resident |
| --- | --- | --- | --- |
| To | house / Manager / Vendor / admin, typed email or phone | Manager, admin | household, Manager, admin |
| Channels | "Communication type" dropdown under To (multi-select): PropLane, Email, SMS (SMS UI on) | no dropdown: one sponsored email delivery (also the recipient's inbox copy) | "Communication type" dropdown: PropLane, Email |
| Schedule | yes | no (no vendor scheduled-send route) | no (residents schedule from the thread composer; New message hides it on purpose) |
| Attach | yes | yes (`/api/vendor/send-inbox-message` takes `attachmentUrls`) | yes (`/api/portal/send-inbox-message`) |
| Draft with PropLane | yes | no | no (the only draft endpoint, `/api/portal/inbox-draft-reply`, drafts as the manager) |

A hidden control is dropped, never disabled. Text is manager-only and goes from
the work number. Vendor and resident recipients are picked from the handed list
only: a typed address is rejected, and the server re-authorizes every recipient.
The composer never writes to a thread. It hands the panel a
`ScopedInboxSendPayload`; the panel's send function owns the request and adds to
the thread only after the send is authorized. A refusal (`false` or a throw)
keeps the draft, the attachments and the `sendId`, so Retry is idempotent.

**Admin keeps its own component, not its own chrome.** `admin-compose-modal.tsx`
renders `PortalDialog` with the shared fields (`PortalMessageComposeModalBody`,
`PortalMessageSubjectField`, `PortalMessageBodyField`,
`PortalMessageScheduleFields`) and the one footer primary — never a hand-rolled
`Modal` with its own inputs. What stays admin's own is the audience (everyone /
all managers / chosen people), because admin messages groups where the manager's
To field picks individuals.

The "Recipients" line on the left card and in the preview lists the people picked
AND the addresses or numbers typed in as chips (`composeRecipientSummary`): it may
never read "Not selected" while the To field is showing a recipient.

## Listing, application and tour links

The approved studio redesign uses the full-page Home → Recipient → Review
wizard for `ShareLeadLinkModal`. It shares the existing authorized send API;
see `send-listing-modal.md`. Other sends retain the compose chrome above.

## The manager workspace invite

`workspace-invite-sheet.tsx`'s Send row has no chooser and no New-message
step: a phone or email recipient goes straight out through
`deliverManagerDirectoryMessage` with the auto-formatted body
(`formatInviteMessageBody`/`formatInviteMessageSubject`) the moment Send is
pressed, and a PropLane-code recipient instead POSTs the addressed invite
directly to `/api/pro/account-links`. There is nothing to preview or edit
first. This is narrower than the dominant chrome above on purpose — the sheet
already shows the recipient, the role, and the houses before Send is
pressable — and it replaces the old three-path chooser → Continue →
New-message flow that used to exist for this one surface. The vendor invite
keeps that older chooser → Continue → New-message shape unchanged; do not
collapse it to match the sheet without a separate decision.

## Body is auto-formatted from every fact

The Message field is never left blank for a system send. A single builder
fills it from **every field collected on the previous step**. The manager can
edit the draft; the builder must not drop a fact.

| Send | Body must include |
| --- | --- |
| Workspace invite | Inviter name, workspace name, each house label (or “no houses yet”), the live invite URL, PropLane code if that path was used, phone if the message path was used |
| Vendor invite | Manager name, vendor name, trade, phone if entered, the live invite URL, PropLane code if used |
| Any other system send | Every id, name, amount, date, and link the previous step already has |

Put the builder next to the send (`formatInviteMessageBody` for invites). Do
not hand-write a second template in the modal.

## Send via

`PORTAL_MESSAGE_SEND_VIA_OPTIONS`: PropLane, Email, SMS. The primary button
label is `portalMessageConfirmSendLabel` (Send email / Send SMS / Send
message / Schedule). SMS stays gated on a live work number. Email is a
**channel on this page**, not an invite-method tab.

**New message can text a roster vendor (Oct 6).** A vendor is picked under Vendor and
texts the vendor row's OWN saved phone (a phone with no email is enough:
`textOnlyVendors` contacts, New message only). The "I work with this vendor" box is
shown only when `GET /api/manager/vendor-text-consent` says the first text still needs
it, with the exact "Sent as" line; the Send is refused without it, an opted-out vendor
is refused before the request, and a vendor text never schedules. The Vendors row menu
and the vendor record header open this modal on that vendor by text (a staged
`vendorRecordId` prefill). Hidden with the rest of the SMS compose when
`SMS_COMM_UI_ENABLED` is off.

## Message a whole house

A house recipient in New message ("⌂ <address> · everyone living there (N)") is ONE copy per person, never a
group text: the sheet reads the people from `GET /api/portal/house-recipients` (the occupancy snapshot, the house
re-checked against the workspace and the viewer's Communication grant) ONCE per pick - that answer is everyone
living there with the short-stay guests flagged, and "Include short-stay guests" filters it in place rather than
re-running the snapshot - and sends each person through the existing `/api/portal/send-inbox-message`, three at
a time, so every copy lands in that person's own conversation under the same authorization and a reply stays
one-to-one. Each person's send carries its own `sendId`, kept per content fingerprint: the send route derives
that turn's message ids from it, so a fan-out refused part-way (the per-minute send cap) is re-tried - by the
fan-out itself for a 429, or by the manager pressing Send again - without a second copy, email or text for
anyone it already reached. The tally (Text / Email / App "n of N", one amber line for who lacks a phone or real
email) and the summary sheet come from `house-message-recipients.ts`; the in-app House chat is unchanged and
stays in-app only.

**A house text is ABOUT the house's workspace.** Each copy carries `houseSendPropertyId` (a name, never
authorization); the send route re-derives the workspace, its OWNER and the actor's Communication grant on that house
(`resolveHouseSendTarget`, `house-message-send.server.ts`) and texts from that workspace's line
(`resolveHouseSmsLine` over `resolveWorkspaceSendLine` / `resolveServiceLine`: a self-serve workspace's own number,
the PropLane line for an `is_service` workspace, the shared line when it is live), billed to the owner's wallet - never
the sender's default workspace, legacy `sms_from_number` or own number; no sendable line REFUSES the text. A wanted
channel with no recorded delivery reads "Not sent" with its reason (`skipped` in the route's response), never "Sent";
nothing is mirrored to the manager's own phone, and a text the outbox only deferred is followed to its inbox message
through `inbox_message_provider_refs` (`outbox:<id>`) so it stops reading "Sending…".

## Tests

A new send surface fails if it does not import the shared compose fields, or
if the auto-formatted body omits a collected fact. Source-guard the field
order against New message.
