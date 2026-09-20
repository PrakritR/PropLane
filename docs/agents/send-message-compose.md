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
Subject       [ text ]        Send via   [ PropLane · Email · SMS ]
Message       [ textarea ]
☐ Schedule for later
                              [ Send email | Send SMS | Send message | Schedule ]
```

Use the existing primitives — do not restyle them:

- `ScopedInboxComposeModal` / `PortalNotificationPreviewModal`
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

## The manager workspace invite is the one deliberate exception

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

## Tests

A new send surface fails if it does not import the shared compose fields, or
if the auto-formatted body omits a collected fact. Source-guard the field
order against New message.
