# Action event catalog

`emitActionEvent` in `src/lib/action-events.server.ts` is the only fanout bus for
system-created lifecycle messages. Domain adapters render audience-safe copy; the
bus owns persistence, preference-aware inbox/email/SMS delivery, idempotency,
deferral, and retry. This file owns the producer and consumer contract only — the
event names, audiences and categories are read from the code, never copied here.

**Which events exist** — `AUTOMATED_MESSAGE_CATALOG` in
`src/lib/automated-messages-settings.ts` is the one enumeration of every
`(domain, event)` with its audiences and settings area, and the read-only
"What PropLane sends" list is built from it so it cannot drift
([`docs/agents/automated-communication.md`](agents/automated-communication.md)).
`ACTION_EVENT_CATALOG` in `src/lib/domain-action-events.server.ts` is the typed
subset that file's renderers cover (`payment`, `lease`, `application`,
`service_request`, plus the `work_order` names). Emission itself is per-domain —
`work_order` (`work-order-events.server.ts`), `tour` and the team-only
`availability` (`tour-events.server.ts`), `inspection`
(`inspection-events.server.ts`), `task`
(`work-order-vendor-messages.server.ts`), `move_in_form`
(`move-in-forms/move-in-form-events.server.ts`), `vendor_banking`
(`vendor-banking/events.server.ts`), and `channel_booking`
(`channel-booking-events.server.ts` — owned by
[`docs/agents/integrations.md`](agents/integrations.md) § Two-way with Airbnb).
Each adapter passes its own `NotificationCategory`; the bus never infers one from
the domain.

## Producer contract

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

Delivery (for every audience but `team`, and but a `manager` copy of what that
manager themself did — both are PropLane Assistant notices fanned out to the
owner and every teammate with the house, never a Team chat post, see
[`docs/agents/automated-communication.md`](agents/automated-communication.md))
continues to use one person-pair conversation, Pacific timestamps,
server-side recipient authorization, and the durable inbox rules in
`docs/agents/communication-inbox.md`. Email and SMS follow the recipient's
category preferences. Deferred and failed rows are retried by
`retryDueActionEventDeliveries`; automated SMS remains subject to consent and
quiet hours in the transport layer.
