# Automated communication (PLAN-0915)

Every message PropLane sends without a person typing it, across the resident,
manager and vendor portals — what fires it, who hears it, and where it is
configured. This is the map; the code is the truth, and every row below names
the file that owns it.

## One spine

| Piece | What it is | Owner |
| --- | --- | --- |
| **Action events** | A state change (charge paid, lease signed, vendor accepted) fans out one rendered copy per audience (`manager` / `resident` / `vendor` / **`team`**; `team` is the owner-and-team fan-out: the owner's Assistant plus one Team chat line), idempotent on `eventId`, quiet-hour aware, retried per channel. | `src/lib/action-events.server.ts`; catalogues in `domain-action-events.server.ts`, `work-order-events.server.ts`, `tour-events.server.ts`, `inspection-events.server.ts`, `inbound-message-automation.server.ts` |
| **Team notices and the Team chat** | Routine notices on the ACTION-EVENT bus are one PropLane line in the Team chat; a teammate's Assistant gets a notice only when the event is urgent; the owner always gets theirs; never a per-teammate conversation. (A reminder-rule `team` row is NOT on this bus: `dispatchReminderRow` still gives that teammate their own Assistant notice, and `teamRecipientsScopedToSubject` already narrowed the row to the houses and modules they hold.) A `manager` notice (and a `team` one, for events with no manager copy: tour claimed, availability changed) reaches the owner's Assistant, and the team through ONE PropLane line in `team-thread:<owner>:ws:<workspace>` (one plain sentence from `buildTeamNoticeLine`: "<Event and what happened>: <subject>, <amount>, <house and room>, <who>." e.g. "Charge created: Kitchen faucet drip, $140, Test Manager."; a work order reads "Service request filed"; prefixed "Emergency. " when urgent; no dots, pill or subtext; the list preview never says "You:" for a PropLane line), idempotent on `action-event:<eventKey>:team`. A caller that hands `notifyPropertyScopedManagersFromAgent` no `teamNotice` still posts exactly one line: `derivedTeamNotice` builds "`<module or eventLabel>` · `<subject, else the notice's first line>`" keyed `<idempotencyKey without its :manager/:team suffix>:team`, so the Team chat never silently loses a routine event — but an event with NO idempotency key (nothing to make the post idempotent on) posts no line at all rather than risk a duplicate. The line is then texted by `relayTeamChatMessageToSms` to each member whose team texting is on (never the owner or the actor). The chat is read by the whole workspace, but that TEXT is a push the owner pays for, so it answers to the same gates as every other automated notice: `memberReceivesNotice` (the per-house / per-module notification grant) and the member's own topic switch (`resolveManagerNotificationChannels().categoryEnabled`) — a bookkeeper is not texted a maintenance line, and neither is anyone off the house. The LINE is not scoped: the Team chat is one workspace-wide conversation, so every member reads it whatever houses they hold — that is the point of collapsing a notice per teammate into one line, and it is why the line carries only the event, its subject, the house and room, who acted and the state. Never a contact detail (a resident's email address or phone) and never a note the resident wrote. A teammate named as a `manager` recipient gets NO person-to-person thread for a routine event (`deliverProjection`); only an **urgent** event (Emergency priority / `URGENT_REMINDER_KINDS`, the `urgent` flag and nothing else) also reaches each teammate's own Assistant (text from the workspace work number, billed to the OWNER; email from the work email) and their per-person path. A workspace of one person has no Team chat (`ensureWorkspaceTeamThread` needs two or more people): the owner's notice is all there is. | `notifyManagerFromAgent` (`agent-notify.server.ts`), `notifyPropertyScopedManagersFromAgent` (`co-manager-notification-recipients.server.ts`, takes `urgent` + `teamNotice`), `deliverProjection` + `teamModuleForDomain` in `action-events.server.ts`; the chat: `team-comms.server.ts` (owner: [`communication-inbox.md`](communication-inbox.md), [`sms-system.md`](sms-system.md)); coverage `tests/unit/team-chat-notices.test.ts` |
| **Send mode** | Auto-send vs draft-for-review, decided ON THE BUS for every domain from the workspace owner's `reminderRules.automationSendMode` (`partyFacing` is read; `team` is stored but no longer read, there is no team draft) — the ONE account-wide switch left, "Resident & vendor messages need my approval first" on Settings → Communication (S020, captain 2026-09-27). A property or workspace override is never consulted (fixed reminders below). A draft is a terminal delivery: it lands as a `requiresReview` inbox draft the manager approves by hand, never a later real send. **Two resolvers, deliberately different on failure:** `resolveAutomationSendModeForEvent` is for the shared bus and resolves an unreadable row to `auto`, because dozens of shipped automations must keep delivering; `partyFacingAnswerHold` is for a caller that must fail CLOSED (the work-email auto-reply, `inbox-ai-drafts.md` § Server auto-reply) and so reads the workspace row strictly — it THROWS rather than answering "send it", and it also holds inside quiet hours, so an answer written at 3am waits for the manager instead of reaching the sender overnight. | `src/lib/automation-send-mode.ts`, `automation-send-mode.server.ts` (`resolveAutomationSendModeForEvent`, `partyFacingAnswerHold`), `action-event-draft-review.server.ts` |
| **Reminder rules** | **Fixed (S020, captain 2026-09-27): "reminders always consistent for everything… remove adjustable reminders."** Every kind's timing/channel/audience is the built-in default ALWAYS — `loadReminderSettings` / `loadReminderSettingsForProperty` / `loadReminderSettingsResolver` ignore every stored account, workspace, and property row (nothing is deleted, just never read). Quiet hours are the built-in default window too. The read-only map of what actually sends is `WhatProplaneSends`, embedded on Settings → Communication. | `src/lib/reminders/rules.ts` (kinds, defaults, `URGENT_REMINDER_KINDS`, `VENDOR_AUDIENCE_KINDS`), `settings.server.ts`, `components/portal/what-proplane-sends.tsx`, `subjects/*.server.ts` (one sweeper per anchor), `current.server.ts` (send-time currency) |
| **Delivery** | `deliverPortalInboxMessage` writes the inbox thread (always) and mirrors to email / text by the **recipient's** preferences. | `src/lib/portal-inbox-delivery.ts`, `notification-preferences.ts` (`resolveChannels`) |
| **Per-event switch + template** | Every action event is a row in the owning Settings tab ("Messages sent automatically") with an on/off per audience and an editable template. Absent = on, default copy. | `src/lib/automated-messages-settings.ts` (catalogue), `automated-messages-settings.server.ts`, applied in `emitActionEvent` and the lease envelope |
| **Action sweeps** | Not messages: offers expiring, unanswered confirmations auto-closing. Run on the same 5-minute tick. | `work-order-offer-expiry.server.ts`, `work-order-resident-confirmation.server.ts` |

Invariants:

- **Both sides.** A moment names what the resident hears and what the manager hears; a vendor is a third audience on service kinds.
- **Inbox is the record.** Email/text are mirrors gated by the recipient's own preferences (`notification_preferences.row_data` for residents and vendors; alert routing for managers). A manager never overrides a resident's channel choice.
- **A manager's own copy** of an event they (or the system acting as them) sent is an Assistant notice, never a self-send (`deliverProjection` in `action-events.server.ts`).
- **Cross-party copies** (vendor → resident, resident → vendor) are sent *as the manager* — the inbox refuses unconnected accounts (`workOrderEvent`'s `senderAudience` split).
- **Team notices are property-and-module scoped, deny by default.** The `team` recipient's `userId` is the PROPERTY OWNER (`resolvePropertyOwnerUserId`), never whoever acted. A routine event reaches the owner's Assistant and the team's ONE Team chat line (table above); the house-and-module grant then decides who that line is TEXTED to, and who is noticed DIRECTLY when the event is urgent: teammates whose accepted grant assigns that house with the domain's module (`teamModuleForDomain`: payments, leases, applications, services, calendar) at `notification`; no house means the owner alone, and a failed grant read narrows to the owner (for the relay, to nobody). A `team` copy for a person who also has a `manager` copy is dropped (one fan-out), and the actor is always excluded. An urgent teammate's line reads in the actor's name ("Ambika approved…", `teammateNoticeText`). A `team` recipient is still pushed for four moments: work order accepted / completed, tour confirmed / **claimed**, availability **changed** (`work-order-events.server.ts`, `tour-events.server.ts`). Every other manager notice — lease sent, payment received, an application decision, the rest — reaches the same people through the `manager` fan-out, so no event needs a `team` copy added to it to be team-visible.
- **Every Assistant notice is texted and emailed, from the workspace's identity.** `notifyManagerFromAgent` writes the recipient's Assistant thread (one per person per workspace, resolved from the notice's house, never the browser cookie), texts their verified phone from the workspace work number (`"PropLane: …"`, dedupe `notice:<idempotencyKey>:<memberId>`) and emails their account address from the workspace work email (idempotent per key and recipient). A teammate is texted from the OWNER's number and the OWNER's wallet (`senderOwnerId`), never billed. SMS needs a verified phone, no STOP, `sms_forward_inbound` on, a sendable number and credit; any miss is a quiet no (in-app and email still go). The email leg honors the alert destination (`none` = no mail) and the topic switch. The ONE exception is a booking: the workspace owner is mailed for every booking whatever their destination says, on the same idempotency key as this notice's own mail, so they still get exactly one ([`bookings.md`](bookings.md) § Every booking has a name). Consent is the recipient's own verified phone (`isManagerRecipientSmsPurpose` → `ensureTeamNoticeScopedSmsConsent`). Owner: [`sms-system.md`](sms-system.md).
- **Drafts queue, they never overwrite.** A second automated draft for a person waits behind one still pending (`aiDraftQueue`, promoted by `advanceInboxAiDraft`), and the inbox AI auto-send latch skips any draft with `requiresReview`. There is no team draft any more.
- **Regulated wording is never automated.** Delinquency, deposit accounting and adverse-action rows remind the manager that something is due and link the tool; they never draft the notice.
- **Emergencies bypass quiet hours** — `URGENT_REMINDER_KINDS` skip the push-forward; urgent action events skip SMS deferral; a vendor's own bypass is their setting. A routine event's Team chat line is relayed on the chat's own `transactional` class, so that text is not quiet-hour held either (owner: [`sms-system.md`](sms-system.md) § Team chat relay).
- **No new crons.** New timed sends are new sweepers under `reminders/subjects/`. Adding a kind means: `REMINDER_SUBJECT_KINDS` + default + meta (`subject-settings-meta.ts`) + module (`co-manager-notification-recipients.server.ts` **and** its client mirror in `pro-portal-automation-settings-panel.tsx`) + category (`dispatch.server.ts`) + noun (`render.ts`) + label (`reminder-history/route.ts`) + the `portal_reminder_records` kind check (migration) + a sweeper + a currency check.

## Settings

**Reminders are fixed (S020, captain 2026-09-27).** The Reminders pane left Settings entirely, along with Applications, Lease, Tours, Residents, Services, and Tasks (their own choices moved to each property's own section; S019). Settings → Communication now carries the read-only **"What PropLane sends"** list (`WhatProplaneSends`, built from `DEFAULT_REMINDER_RULES` / `AUTOMATED_MESSAGE_CATALOG` so it can never drift) plus the single kept control, **"Resident & vendor messages need my approval first"**. The table below is no longer a settings surface — it is the permanent, non-editable default every workspace now sends. The old per-area editing components (`AutomationRuleRows`, `ManagerReminderRuleSettingsPanel`, the `*RemindersSettingsBundle`s, `AutomatedMessagesList`, and the hub panel itself, `pro-portal-automation-settings-panel.tsx`) still exist and are still reachable from each list page's own gear icon (`ProPortalSettingsModal`, e.g. Tours' or Applications' settings gear) — that surface is unrelated to the manager Settings nav and out of scope for S019/S020; whatever it saves is simply never read by anything that decides what actually sends.

| Area (on the Reminders hub) | Rows (reminders) | Messages sent automatically (events) |
| --- | --- | --- |
| Services | Acknowledge new requests (promise), unassigned / emergency escalations, **vendor silent after accept (re-offer)**, add-on decision, approved-but-unpaid, offers expire, tell me when no vendor answers, require On my way, ask resident to confirm the fix (+ auto-close), share ratings, offer expiring (vendor), no On my way, invoice nudge, invoice approval, vendor document expiry, visit reminders (You / Team / Resident / **Vendor**) | filed, offered, **new service offered to your preferred vendor**, **vendor assigned**, expiring, expired, filled, declined, accepted, scheduled, rescheduled, cancelled, on the way, done, confirmed, reopened, auto-closed, rated, invoiced, invoice approved/disputed, paid, **vendor silent**; add-on submitted/approved/denied/returned |
| Lease | Lease ending (you 90/60/30, resident 60/30), **renewal offer (60d)**, renewal offer expiry, countersignature overdue, move-in (7/1), payment method missing, move-out (30/7/1), **move-out instructions (14d)**, **deposit return notice (day of)**, schedule move-out inspection, deposit accounting (+ deadline days), signing reminders, document signature reminder | created, sent, signed by resident, countersigned, fully signed, voided, move-out date set, lease extended |
| Applications | Response promise, decision reminder, approved-no-lease, incomplete application (applicant / you), post-tour apply link | submitted, approved, declined, withdrawn |
| Tours | Guest and manager tour reminders now ship on fixed defaults, not a per-workspace rule (C191) — see "What PropLane sends" above | confirmed, cancelled by guest, claimed by a teammate (team); bookings: new / cancelled on any linked channel calendar, Other calendar included, plus new / cancelled for a booking made in PropLane itself (manager, `channel_booking` domain; owned by [`bookings.md`](bookings.md) § Booking alerts and reminders). The guest short-stay notices (requested / confirmed / declined / expired) ride the same domain and are owned by [`bookings.md`](bookings.md) § Guest portal stays; they have no `AUTOMATED_MESSAGE_CATALOG` entry yet, so "What PropLane sends" does not list them |
| Payments | Rent reminder schedule, my payment alerts, delinquency, outgoing payments | charge created, processing, received, partial, failed, refunded, late fee applied, deposit received |
| Communication | Unanswered message reminder, welcome sequence (off), AI draft auto-send | after-hours reply, emergency flagged, availability changed (team) |
| Bookings | Booking reminders | — |
| Inspections | Room photos (resident / you) | resident submitted, report reopened |
| Tasks | Task reminders, overdue | **task assigned to a vendor** |
| Residents | Welcome message | — |
| Move-in forms | Per-property "Remind residents": 2 days before + due date, due date only, or never (`reminders/subjects/move-in-forms.server.ts`, claimed on `reminders_sent`) | sent, reminder, submitted (`move-in-form-events.server.ts`; the submitted notice can also email the manager) |

Resident → Settings → Preferences: per-category Email / Text (messages, lease & move, payments, services, applications, **tours**, **inspections**, phone calls, account) plus **quiet hours for texts**.

Vendor → Settings → Notifications: per-topic Email / Text (offers, schedule, invoices, payments, messages, documents, reviews), **visit reminders** (timing + text), **quiet hours for texts** with an emergency bypass. Read at send by `resolveChannels` (`vendor-notification-settings.server.ts`); the three legacy `vendor_business_profiles` booleans are mirrored on save.

## The vendor loop

```
filed → (unassigned 24h / emergency 1h → manager; preferred vendor offered at once) → offered (to the preferred vendor the moment it is filed, or by the manager; expires; vendor nudged before; manager told when nobody answers; siblings "filled" on accept)
→ accepted (resident who+when, vendor access notes, manager price) → visit reminders (resident, manager, vendor) → On my way (vendor tap or OMW text → resident)
→ done (resident gets a signed "was this fixed?" link at /services/confirm, or YES/NO by text) → ✓ closed + rating · ✗ reopened, everyone told · silence → auto-closed
→ invoice (nudge to vendor at +3d; approval reminder to manager at +3d) → approved / disputed → paid
```

The confirmation token is random, stored hashed on `row_data.residentConfirmation`, and lapses after seven days (`work-order-resident-confirmation.server.ts`).

## Vendor auto-messages (comms-safety-0929, Part C)

Three moments a vendor used to hear nothing about. All three are **always on** (captain's
D4: no Settings toggle; "Resident & vendor messages need my approval first" still turns each into a
draft, and the vendor's own Settings → Notifications decides their text and email), sent **as the
owning manager** from the workspace's own number and work address (never the resident), with
**facts only** (reference, service title, house + unit, emergency flag, visit time, a link; no resident
name or phone until the vendor accepts) and copy that says **"service"**.

| Moment | Event | Who is messaged | Owner |
| --- | --- | --- | --- |
| A resident files a service | `work_order:vendor_new_service` | The **preferred vendor** for that house and trade (D3), as a real offer (`sendWorkOrderVendorOffers` with `newService: true`). No preferred vendor set → nobody is messaged and the "unassigned" alert stands. Skipped when vendor dispatch is on (it proposes, the manager approves). | `offerNewServiceToPreferredVendor`, kicked off in `after()` from `portal-work-orders/route.ts` for a new resident-filed row |
| A vendor is put on a service (Services panel, or the Assistant's `assign_vendor`) | `work_order:vendor_assigned` ("You were assigned …") | The assigned vendor | `emitVendorAssigned`; the route sends it as a **diff against the stored row** (`vendorId` changed, not `selfAssigned`), `assign_vendor` sends it after its write |
| A task is assigned to a vendor | `task:task_assigned_vendor` ("New task from …") | The assigned vendor | `emitVendorTaskAssigned`, from `createManagerTaskRow` and from `patchManagerTaskRow` when the assignee moves onto a different vendor |

All of it lives in `src/lib/work-order-vendor-messages.server.ts` (helpers) and
`work-order-events.server.ts` (copy + `vendorAssignedEventId`).

- **One delivery key per assignment**: `<service>:vendor_assigned:<vendor>:<assignedAt>` (tasks:
  `task:<id>:task_assigned_vendor:<vendor>:<changedAt>`). A retry or a re-sync of the whole list
  sends nothing new; reassigning later carries a new `assignedAt` and does send.
- **No duplicate with accepted/scheduled.** A bid accept and `executeDispatch` already tell the vendor
  ("accepted", or "scheduled" when a slot was booked). `executeDispatch` therefore never emits
  `vendor_assigned`, and `emitVendorAssigned` itself stands down when an `accepted`/`scheduled`
  action event for the service is on record at or after `vendorAssignedAt`.
- **The vendor's own quiet hours (default 8pm–7am) hold the TEXT only.** `emitActionEvent`
  (`withVendorQuietHours`) defers a vendor recipient's text to the end of THEIR window while the
  in-app message and email go at once; an emergency skips the wait only when the vendor kept
  "emergencies can text me anytime" on (`vendorQuietHoursDeferral`).
- **Texts go through the owner dispatcher**, not the resident path. `deliverPortalInboxMessage` used to
  hand a vendor text to `sendResidentOutboundSms`, which a vendor (no open resident thread, no
  cached `sms_from_number`) always failed with `managed_sender_scope_required`. A vendor recipient now
  goes through `sendVendorEventSms` → `enqueueOwnerSms` (`purpose: vendor_conversation`, the workspace
  owner's number, `dedupeKey: vendor-event-sms:<action-event message id>`), which needs the vendor's
  recorded `sms_consent_at` and no STOP (`ensureVendorConversationConsent`), and which reserves
  messaging credit before the provider call like every other text. A standing "no" (no consent, STOP,
  credit, paused runtime) reports no text outcome, so the bus has nothing to retry; the in-app message
  and email are never held back.
- **"unavailable" earns one retry pass.** A closed text channel (STOP, no verified phone, topic
  switched off) was counted as a failure and re-queued every five minutes forever; it is now retried
  once and then settled (`hasSmsFailure` in `action-events.server.ts`).
- Preferences are stored under the **trade label** (`VENDOR_TRADE_OPTIONS`, "Plumbing"), a service's
  `category` is the lowercase enum ("plumbing"); `preferenceTradesForCategory` maps one to the other.

## Three more moments (PLAN-0915 area 4)

**Escalations (Services).** "Unassigned request" (`work_order_unassigned`, 1 day) and
"Emergency unassigned" (`work_order_unassigned_emergency`, 1 hour → you + co-managers by
default) are ordinary `reminderRules` kinds, resolved per work order's property through
`resolveReminderSettingsForRow`, same as every other Services reminder. "Vendor silent after
accept" is different in kind: it is an ACTION, not a message. A work order whose vendor
accepted but never scheduled the visit is unassigned and re-offered to the next-best declined
bid — `sweepVendorSilentAfterAccept` (`subjects/services.server.ts`) reuses
`sendWorkOrderVendorOffers` (`work-order-offers.server.ts`) for the actual re-offer, no second
notification path. Its enable/hours (`reofferAfterVendorSilentHours`, default 24h) live in
`serviceAutomation` beside `requireOnMyWay` and `notifyWhenNoVendorAnswers`, resolved by the
same `resolveServiceAutomationSettingsForRow`. With nobody left to re-offer to, the manager is
told once (`vendor_silent` work-order event) and the job stamps `vendorSilentEscalatedAt` so it
stops re-checking every tick.

**Lease-ending sequence (Leases).** Three resident-facing `reminderRules` kinds, swept
alongside `lease_ending`/`move_out` in `subjects/tenancy.server.ts`'s existing `SWEEPS` list:

| Kind | Fires | Anchor |
| --- | --- | --- |
| `lease_renewal_offer` | 60 days before | the lease end date |
| `move_out_instructions` | 14 days before | an explicit move-out date |
| `deposit_return_notice` | day of (the smallest valid lead) | an explicit move-out date |

All three are informational — a nudge and a pointer, never the regulated notice itself. Deposit
*accounting* (the figure, the deadline) stays the existing manager-only `deposit_accounting`
kind; `deposit_return_notice` only tells the resident today is the day and where the real
accounting will land.

**Vendor settings honoured at send, not only offers.** Two gaps, both closed here. First,
`sendVendorNotification` (`vendor-notification-delivery.ts`) — the ad hoc vendor email behind a
scheduled visit and a bid-offer request — used to send a raw, unconditional Resend email and
never text, bypassing the vendor's own Settings → Notifications topic on/off, quiet hours, and
phone opt-out entirely. It now routes through `deliverPortalInboxMessage`'s `eventCategory` +
`vendorTopic` gate, the same `resolveChannels` → `resolveVendorChannels` every reminder's vendor
copy already used. Second, a reminder materialized for a vendor recipient (an offer expiring, an
invoice nudge, a document expiring) was pushed out of quiet hours using the MANAGER's workspace
`reminderRules.quietHours` — the same window applied to every recipient — never the vendor's own
window. `ReminderRecipient.quietHours` (`queue.server.ts`) lets a caller attach a per-recipient
override; the three vendor-audience sweeps in `subjects/services.server.ts` now load it via
`loadVendorQuietHoursForUsers` (`vendor-notification-settings.server.ts`) and attach it to the
vendor recipient, so a vendor's own quiet hours — not the manager's — decide when THEIR copy
actually sends.

## What is deliberately not automated

- Anything that writes a regulated notice.
- Cosigner and documents-requested reminders — the product has no "invited" state to anchor on.
- Tour feedback and the vendor weekly summary — no page / no sender yet; their kinds exist but are not drawn.
- Guest-facing booking messages — channel feeds carry no guest contact.
- Native push — every row lands in the inbox; push is its own plan.

## Proving a change

Run the dispatcher locally (`GET /api/cron/dispatch-reminders` with `Authorization: Bearer $CRON_SECRET`) and read `portal_reminder_records` / `action_event_deliveries`. A row that "should have fired" but did not is usually one of: the anchor is already past (reminders queue future sends only), the rule is off, the recipient has no email, or the currency check found the subject moved on.

## Booking check-in / check-out reminders

The `booking` reminder kind is on by default for the owner AND teammates with the house (the one kind whose
default audience includes `team`, pinned in `reminder-team-scope.test.ts`): 9:00 PT the day before check-in
and 9:00 PT on check-out morning. Both are swept in `subjects/bookings.server.ts` under one rule; the
check-out is a second subject (`<id>:out`) with its own anchor, and the message is a finished headline
(`payload.headline`) with a link to the booking record.

## Fan-out by role (Oct 13)

`notifyPropertyScopedManagersFromAgent` no longer computes its own recipients: for an URGENT event it asks
`resolveWorkspaceNoticeRecipients` (role matrix in `co-manager-access.md`), so a house-less event reaches property
managers, leasing and viewers, a payments event reaches the bookkeeper, a services event reaches maintenance, each in
their own Assistant thread for the owner's workspace. A ROUTINE event names the OWNER alone there and tells the team
with one Team chat line (captain 2026-10-14, table above), whose text relay reads the same matrix through
`memberReceivesNotice`. Signature, "Also notify" recipients and the owner-first failure rule are unchanged.
