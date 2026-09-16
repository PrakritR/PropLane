# Automated communication (PLAN-0915)

Every message PropLane sends without a person typing it, across the resident,
manager and vendor portals — what fires it, who hears it, and where it is
configured. This is the map; the code is the truth, and every row below names
the file that owns it.

## One spine

| Piece | What it is | Owner |
| --- | --- | --- |
| **Action events** | A state change (charge paid, lease signed, vendor accepted) fans out one rendered copy per audience, idempotent on `eventId`, quiet-hour aware, retried per channel. | `src/lib/action-events.server.ts`; catalogues in `domain-action-events.server.ts`, `work-order-events.server.ts`, `tour-events.server.ts`, `inspection-events.server.ts`, `inbound-message-automation.server.ts` |
| **Reminder rules** | Timed relative to an anchor ("1 day before the visit", "24 hours after filed"). One rule per `ReminderSubjectKind`, per manager, in `manager_automation_settings.row_data.reminderRules`. Swept and sent by `/api/cron/dispatch-reminders` every 5 minutes. | `src/lib/reminders/rules.ts` (kinds, defaults, `URGENT_REMINDER_KINDS`, `VENDOR_AUDIENCE_KINDS`), `subjects/*.server.ts` (one sweeper per anchor), `current.server.ts` (send-time currency) |
| **Delivery** | `deliverPortalInboxMessage` writes the inbox thread (always) and mirrors to email / text by the **recipient's** preferences. | `src/lib/portal-inbox-delivery.ts`, `notification-preferences.ts` (`resolveChannels`) |
| **Per-event switch + template** | Every action event is a row in the owning Settings tab ("Messages sent automatically") with an on/off per audience and an editable template. Absent = on, default copy. | `src/lib/automated-messages-settings.ts` (catalogue), `automated-messages-settings.server.ts`, applied in `emitActionEvent` and the lease envelope |
| **Action sweeps** | Not messages: offers expiring, unanswered confirmations auto-closing. Run on the same 5-minute tick. | `work-order-offer-expiry.server.ts`, `work-order-resident-confirmation.server.ts` |

Invariants:

- **Both sides.** A moment names what the resident hears and what the manager hears; a vendor is a third audience on service kinds.
- **Inbox is the record.** Email/text are mirrors gated by the recipient's own preferences (`notification_preferences.row_data` for residents and vendors; alert routing for managers). A manager never overrides a resident's channel choice.
- **A manager's own copy** of an event they (or the system acting as them) sent is an Assistant notice, never a self-send (`deliverProjection` in `action-events.server.ts`).
- **Cross-party copies** (vendor → resident, resident → vendor) are sent *as the manager* — the inbox refuses unconnected accounts (`workOrderEvent`'s `senderAudience` split).
- **Regulated wording is never automated.** Delinquency, deposit accounting and adverse-action rows remind the manager that something is due and link the tool; they never draft the notice.
- **Emergencies bypass quiet hours** — `URGENT_REMINDER_KINDS` skip the push-forward; urgent action events skip SMS deferral; a vendor's own bypass is their setting.
- **No new crons.** New timed sends are new sweepers under `reminders/subjects/`. Adding a kind means: `REMINDER_SUBJECT_KINDS` + default + meta (`subject-settings-meta.ts`) + module (`co-manager-notification-recipients.server.ts` **and** its client mirror in `pro-portal-automation-settings-panel.tsx`) + category (`dispatch.server.ts`) + noun (`render.ts`) + label (`reminder-history/route.ts`) + the `portal_reminder_records` kind check (migration) + a sweeper + a currency check.

## Settings

The **Notifications** hub holds globals only: alert destination, digest, quiet hours, sent history, and an index into every area tab. Each area tab owns its rows:

| Tab | Rows (reminders) | Messages sent automatically (events) |
| --- | --- | --- |
| Services | Acknowledge new requests (promise), unassigned / emergency escalations, add-on decision, approved-but-unpaid, offers expire, tell me when no vendor answers, require On my way, ask resident to confirm the fix (+ auto-close), share ratings, offer expiring (vendor), no On my way, invoice nudge, invoice approval, vendor document expiry, visit reminders (You / Team / Resident / **Vendor**) | filed, offered, expiring, expired, filled, declined, accepted, scheduled, rescheduled, cancelled, on the way, done, confirmed, reopened, auto-closed, rated, invoiced, invoice approved/disputed, paid; add-on submitted/approved/denied/returned |
| Lease | Lease ending (you 90/60/30, resident 60/30), renewal offer expiry, countersignature overdue, move-in (7/1), payment method missing, move-out (30/7/1), schedule move-out inspection, deposit accounting (+ deadline days), signing reminders, document signature reminder | created, sent, signed by resident, countersigned, fully signed, voided, move-out date set, lease extended |
| Applications | Response promise, decision reminder, approved-no-lease, incomplete application (applicant / you), post-tour apply link | submitted, approved, declined, withdrawn |
| Tours | Guest and manager tour reminders, request unanswered, offer other times, no-show prompt, tour-interest follow-up | confirmed, cancelled by guest |
| Payments | Rent reminder schedule, my payment alerts, delinquency, outgoing payments | charge created, processing, received, partial, failed, refunded, late fee applied, deposit received |
| Communication | Unanswered message reminder, welcome sequence (off), AI draft auto-send | after-hours reply, emergency flagged |
| Inspections | Room photos (resident / you) | resident submitted, report reopened |
| Tasks | Task reminders, overdue | — |

Resident → Settings → Preferences: per-category Email / Text (messages, lease & move, payments, services, applications, **tours**, **inspections**, phone calls, account) plus **quiet hours for texts**.

Vendor → Settings → Notifications: per-topic Email / Text (offers, schedule, invoices, payments, messages, documents, reviews), **visit reminders** (timing + text), **quiet hours for texts** with an emergency bypass. Read at send by `resolveChannels` (`vendor-notification-settings.server.ts`); the three legacy `vendor_business_profiles` booleans are mirrored on save.

## The vendor loop

```
filed → (unassigned 24h / emergency 1h → manager) → offered (expires; vendor nudged before; manager told when nobody answers; siblings "filled" on accept)
→ accepted (resident who+when, vendor access notes, manager price) → visit reminders (resident, manager, vendor) → On my way (vendor tap or OMW text → resident)
→ done (resident gets a signed "was this fixed?" link at /services/confirm, or YES/NO by text) → ✓ closed + rating · ✗ reopened, everyone told · silence → auto-closed
→ invoice (nudge to vendor at +3d; approval reminder to manager at +3d) → approved / disputed → paid
```

The confirmation token is random, stored hashed on `row_data.residentConfirmation`, and lapses after seven days (`work-order-resident-confirmation.server.ts`).

## What is deliberately not automated

- Anything that writes a regulated notice.
- Cosigner and documents-requested reminders — the product has no "invited" state to anchor on.
- Tour feedback and the vendor weekly summary — no page / no sender yet; their kinds exist but are not drawn.
- Guest-facing booking messages — channel feeds carry no guest contact.
- Native push — every row lands in the inbox; push is its own plan.

## Proving a change

Run the dispatcher locally (`GET /api/cron/dispatch-reminders` with `Authorization: Bearer $CRON_SECRET`) and read `portal_reminder_records` / `action_event_deliveries`. A row that "should have fired" but did not is usually one of: the anchor is already past (reminders queue future sends only), the rule is off, the recipient has no email, or the currency check found the subject moved on.
