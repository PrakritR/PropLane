# Action event catalog

`emitActionEvent` in `src/lib/action-events.server.ts` is the only fanout bus for
system-created work-order, payment, and lease lifecycle messages. Domain
adapters render audience-safe copy; the bus owns persistence, preference-aware
inbox/email/SMS delivery, idempotency, deferral, and retry.

| Domain | Events | Notification category |
| --- | --- | --- |
| Work order | `created`, `vendor_offered`, `accepted`, `scheduled`, `completed`, `invoiced`, `paid` | `maintenance` |
| Payment | `charge_created`, `payment_processing`, `payment_received`, `payment_failed`, `payment_refunded` | `payments` |
| Lease | `lease_created`, `lease_sent`, `lease_signed`, `lease_voided` | `leases` |

## Producer contract

- Emit only after the authoritative state write succeeds.
- Supply a deterministic `eventId` tied to that transition. Stripe event/session
  ids and persisted transition timestamps are preferred.
- Resolve `managerUserId` and recipients from server-owned scope columns. Never
  trust a model or browser to name another manager's recipient.
- Put only ids, enums, and non-sensitive routing facts in `payload`. Audience
  copy is rendered before it reaches the bus.

## Consumer and thread contract

Each `(event, audience, recipient)` creates one `action_event_deliveries` row.
Replays cannot create another consumer row. The same event-derived `messageId`
is passed through `deliverPortalInboxMessage`, so a retry cannot append the same
turn twice even if delivery succeeded before the outbox status was committed.

Delivery continues to use one person-pair conversation, Pacific timestamps,
server-side recipient authorization, and the durable inbox rules in
`docs/agents/communication-inbox.md`. Email and SMS follow the recipient's
category preferences. Deferred and failed rows are retried by
`retryDueActionEventDeliveries`; automated SMS remains subject to consent and
quiet hours in the transport layer.
