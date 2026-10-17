# Action event catalog

`emitActionEvent` in `src/lib/action-events.server.ts` is the only fanout bus for
system-created lifecycle messages. Domain adapters render audience-safe copy; the
bus owns persistence, preference-aware inbox/email/SMS delivery, idempotency,
deferral, and retry. This file owns the producer and consumer contract only — the
event names, audiences and categories are read from the code, never copied here.

**Which events exist** — `AUTOMATED_MESSAGE_CATALOG` in
`src/lib/automated-messages-settings.ts` is where every `(domain, event)` is
enumerated with its audiences and settings area; the read-only "What PropLane
sends" list and the default-copy preview (`automated-messages-defaults.server.ts`)
are both built from it, so neither can drift from it
([`docs/agents/automated-communication.md`](agents/automated-communication.md)).
The catalog gates no delivery — absent means "on, default copy" — so an event
that emits without an entry still sends while appearing on no surface a manager
can see. A new `(domain, event)` therefore belongs in the catalog in the same
change that starts emitting it.
`ACTION_EVENT_CATALOG` in `src/lib/domain-action-events.server.ts` is the typed
subset that file's renderers cover (`payment`, `lease`, `application`,
`service_request`, plus the `work_order` names). Emission itself is per-domain —
`work_order` (`work-order-events.server.ts`), `tour` and the team-only
`availability` (`tour-events.server.ts`), `inspection`
(`inspection-events.server.ts`), `task`
(`work-order-vendor-messages.server.ts`), `move_in_form`
(`move-in-forms/move-in-form-events.server.ts`), `vendor_banking`
(`vendor-banking/events.server.ts`), and `channel_booking`
(`channel-booking-events.server.ts` — channel stays owned by
[`docs/agents/integrations.md`](agents/integrations.md) § Two-way with Airbnb,
bookings made in PropLane by
[`docs/agents/bookings.md`](agents/bookings.md) § Every booking has a name).
Each adapter passes its own `NotificationCategory`; the bus never infers one from
the domain.

## Producer contract

- **The database must admit the domain and the category before the code emits them.**
  `action_events_domain_check` / `action_events_category_check` are allowlists, so a new
  `ActionEventDomain` or `NotificationCategory` needs a migration widening the matching
  constraint in the same change — otherwise the insert is rejected and the emitters' best-effort
  `catch` hides it (`tests/unit/channel-booking-prod-shape.test.ts` fails a domain the latest
  migration omits).
- Emit only after the authoritative state write succeeds.
- Supply a deterministic `eventId` tied to that transition. Stripe event/session
  ids and persisted transition timestamps are preferred.
- Resolve `managerUserId` and recipients from server-owned scope columns. Never
  trust a model or browser to name another manager's recipient.
- Put only ids, enums, and non-sensitive routing facts in `payload`. Audience
  copy is rendered before it reaches the bus.

The `team` audience and the auto-send / draft-for-review gate are described in
[`docs/agents/automated-communication.md`](agents/automated-communication.md).

## Consumer and thread contract

Each `(event, audience, recipient)` creates one `action_event_deliveries` row;
a `team` recipient's key is `team:<ownerUserId>` (`teamRecipientKey`) so it
never shares the owner's own throttle window. The row carries
`draft_for_review`, so a retried failed draft re-queues the draft rather than
falling through to a real send.
Replays cannot create another consumer row. The same event-derived `messageId`
is passed through `deliverPortalInboxMessage`, so a retry cannot append the same
turn twice even if delivery succeeded before the outbox status was committed.

Delivery continues to use one person-pair conversation, Pacific timestamps,
server-side recipient authorization, and the durable inbox rules in
`docs/agents/communication-inbox.md` — except for the `team` audience, a
`manager` copy of what that manager themself did, and a teammate's `manager`
copy of a ROUTINE event. Those three are the owner's own PropLane Assistant
notice plus ONE PropLane line in the workspace Team chat, with a teammate's own
Assistant reached only when the event is urgent
([`docs/agents/automated-communication.md`](agents/automated-communication.md)).
Email and SMS follow the recipient's category preferences. Deferred and failed rows are retried by
`retryDueActionEventDeliveries`; automated SMS remains subject to consent and
quiet hours in the transport layer.
