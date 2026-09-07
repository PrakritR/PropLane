# Outbound webhooks

PropLane's public API had two pull transports (`/api/mcp` and `/api/v1/tools`,
see [`mcp-api.md`](mcp-api.md)) and nothing that pushed. Outbound webhooks are
the push half: a manager registers an HTTPS endpoint, PropLane POSTs a signed
event to it when something happens, and the receiver reads the details back
through the authenticated API.

They are deliberately **read-only, manager-scoped, and content-free**. A webhook
cannot change anything in PropLane, it only ever fires for the manager who
registered it, and the body carries ids and statuses — never a name, email,
phone number, address or free text.

Code: `src/lib/webhooks/` (`events.ts`, `signature.ts`, `retry.ts`,
`url-safety.ts`, `subscriptions.server.ts`, `deliver.server.ts`), routes
`/api/portal/webhooks[/:id]` and `/api/cron/webhook-deliveries`, UI in
`src/components/portal/pro-api-keys-panel.tsx` (Settings → API & MCP).

## Event catalog

The type list in `src/lib/webhooks/events.ts` is an **allowlist**, checked at
subscribe time and again before a delivery row is written.

| Type | Fires from | Payload keys |
| --- | --- | --- |
| `work_order.created` | `workOrderEvent` (`src/lib/work-order-events.server.ts`), transition `created` | `workOrderId`, `propertyId`, `status` |
| `work_order.updated` | the same lib, every other transition (`vendor_offered`, `accepted`, `scheduled`, `invoiced`, `paid`) | `workOrderId`, `propertyId`, `status`, `previousStatus` |
| `work_order.completed` | the same lib, transition `completed` | `workOrderId`, `propertyId`, `completedAt` |
| `payment.succeeded` | `markHouseholdChargePaidFromStripeSession` (`src/lib/stripe-household-charge.ts`) | `chargeId`, `propertyId`, `amountCents`, `kind`, `status` |
| `payment.failed` | `handlePaymentIntentFailed` (`src/lib/stripe-webhook-financials.ts`) | `chargeId`, `propertyId`, `amountCents`, `kind`, `status` |
| `message.received` | the manager's inbox copy in `deliverPortalMessageThreadSide` (`src/lib/portal-inbox-delivery.ts`) | `threadId`, `scope`, `unread` |

`message.received` deliberately carries no sender, subject or preview.

The request body is:

```json
{
  "id": "<delivery id, stable across retries>",
  "type": "work_order.completed",
  "createdAt": "2026-09-07T18:04:11.000Z",
  "data": { "workOrderId": "…", "propertyId": null, "completedAt": "…" }
}
```

with headers `PropLane-Signature`, `PropLane-Event`, and `PropLane-Delivery`.

## Verifying the signature

`PropLane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.

The timestamp is **inside** the MAC. Without it, anyone who captured one
delivery could replay it forever; with it, a receiver that also checks `t` is
recent has a finite replay window. Verify against the **raw body bytes**, before
any JSON parse — a re-serialized object will not match.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// `rawBody` is the exact string/Buffer the request delivered.
export function verifyPropLaneWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    String(header || "").split(",").map((p) => p.trim().split("=")),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]+$/i.test(parts.v1 || "")) return false;
  // Reject a stale delivery: this is what bounds replay.
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts.v1.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

PropLane's own implementation is `verifyWebhookSignature` in
`src/lib/webhooks/signature.ts` — the snippet above is that function, written
out so a receiver can copy it without depending on this repo.

Respond **2xx as soon as you have stored the event**, then do your work
asynchronously. Anything else (including a 3xx) is a failure and is retried.

## Retry policy

`src/lib/webhooks/retry.ts` is the whole schedule, kept pure so it reads as a
table:

- Attempt 1 fires inline from the emit call.
- Then 1m, 5m, 30m, 2h, 12h after the preceding failure — **5 attempts total**.
- A delivery that exhausts them is marked `exhausted` and never retried again.
- Only an *exhausted delivery* increments `webhook_subscriptions.failure_count`
  (counting every attempt would disable an endpoint after two transient blips).
  10 consecutive exhausted deliveries disable the subscription; a single success
  resets the counter to 0.

Retries are driven by `GET /api/cron/webhook-deliveries`, guarded like every
other cron route (`CRON_SECRET` bearer when configured, open on a non-production
runtime). ⚠️ It is **not** registered in `vercel.json`'s `crons` yet — the same
state `/api/cron/action-event-deliveries` is in — so today only the inline first
attempt fires automatically and the backoff needs an external caller. Register
it (or call it from an existing scheduler) before promising retry to a customer;
a schedule coarser than a minute makes the 1m step effectively the next tick. A disabled subscription still appears in Settings so the manager can
see why it stopped; re-enabling means deleting and re-adding the endpoint.

Deliveries time out after 10s.

## The SSRF rule

A webhook URL is attacker-chosen by construction, and PropLane's server then
makes a request to it from inside its own network. So:

- **https:// only**, default port, no embedded credentials.
- **The host must be public.** `localhost`, loopback, RFC1918, link-local
  (including `169.254.169.254`, the cloud metadata address), CGNAT, multicast,
  `.local` / `.internal` / `.home.arpa`, and any bare label with no dot are all
  refused.
- **The check runs TWICE** — at subscribe time so a bad URL never lands in the
  table, and again immediately before every delivery, because DNS is not stable:
  a hostname that resolved publicly at subscribe time can be re-pointed at
  127.0.0.1 an hour later. Delivery additionally resolves the hostname and
  refuses if *any* resolved address is private.
- **Redirects are never followed** (`redirect: "manual"`). A 302 is the other
  door into the private network.

`isPrivateWebhookHost` is an allowlist-shaped check: anything it does not
recognise as public is refused, not permitted.

## Storage and secrets

`webhook_subscriptions` and `webhook_deliveries`
(`supabase/migrations/20260907130000_webhook_subscriptions.sql`) are RLS enabled
with **no policies** and an explicit DML revoke for `anon` / `authenticated`,
exactly like `manager_api_keys` — `public` is exposed through PostgREST, so a
browser-reachable write grant would let anyone re-point a victim's events at
their own server. Both are classified in
`src/lib/auth/account-purge-manifest.ts` (the subscription on
`manager_user_id`; the delivery journal cascades from it).

The signing secret is **encrypted**, not hashed: PropLane has to reproduce it to
sign every delivery, so the one-way digest that protects an API key cannot work
here. It uses the application keyring (`src/lib/security/data-encryption.ts`)
with a context bound to the owning manager AND the row id, so a ciphertext
lifted onto another row fails to decrypt rather than silently signing. The
plaintext appears in exactly two response bodies — create and rotate — and
nowhere else, ever.

## Adding an event

1. Add the type to `WEBHOOK_EVENT_TYPES` in `src/lib/webhooks/events.ts` and a
   builder to `webhookEventBuilders`. **Ids, enums, counts and flags only** —
   `tests/unit/webhooks-event-payloads.test.ts` checks every builder's output
   against `PII_PAYLOAD_KEYS` and against a scan for values that look like an
   email or a phone number.
2. Call `enqueueWebhookEvent(managerUserId, type, payload)` on ONE line beside
   the success return of the write path. It never throws — a webhook problem
   must not fail the thing that happened — so do not wrap it in your own
   try/catch, and do not add a second emit path.
3. Document it in the catalog above.

Nothing else is needed: the subscription UI renders `WEBHOOK_EVENT_TYPES`
directly, and delivery, retry and disabling are type-agnostic.
