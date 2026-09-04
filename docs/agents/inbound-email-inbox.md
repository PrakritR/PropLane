# Inbound email → portal inboxes

Three kinds of mail arrive through the same Resend Inbound webhook, decided by the
To address:

0. **Manager assistant email** — `assistant+<token>@…` routes to the manager
   email agent when the sender's profile email matches the mailbox owner or an
   assigned co-manager. Provisioned in Settings → Messaging. See
   `src/lib/manager-assistant-email/`.
1. **Conversation replies** — outbound portal conversation emails carry a signed
   `reply+…@${RESEND_REPLY_DOMAIN}` Reply-To; a verified reply is routed into the
   manager↔resident conversation thread (see "Conversation replies" below).
2. **Everything else** (including **support@prop-lane.space**) shows up as a
   message in the **admin portal inbox** (the founder/`PRIMARY_ADMIN_EMAIL`
   scope), so support mail is handled inside the app next to the rest of the
   unified inbox.

## How it works

1. `support@prop-lane.space` is routed to **Resend Inbound**.
2. Resend POSTs a Svix-signed `email.received` webhook to
   `POST /api/webhooks/email/inbound`
   (`src/app/api/webhooks/email/inbound/route.ts`).
3. The route mirrors the Twilio SMS webhook posture: `runtime = "nodejs"`, Svix
   signature verification that **fails closed on Vercel** (unsigned inbound is
   allowed only in local dev), in-memory rate limiting, service-role Supabase
   client. Two shed valves run in order: a coarse instance-wide backstop on a
   **constant** key (the sender key is attacker-chosen, so this is what sheds a
   flood rotating its From — and it bounds how many per-sender buckets one window
   can mint, since the shared `rateLimit` map never evicts), then a per-**sender**
   bucket keyed on the parsed From. Neither is keyed on the client IP: every
   request comes from Resend's own IPs, so an IP bucket would be a global ceiling
   one noisy sender could exhaust for everyone. Both over-limit paths ack 200 (a
   non-2xx makes Resend retry and amplify a flood) and log the shed message id.
4. Ingest (`src/lib/inbound-email/inbound-email.server.ts`) writes a
   `portal_inbox_thread_records` row under **`scope: "admin"`** — the same rail the
   public contact form uses (`src/app/api/public/contact-message/route.ts`). Admin
   scope is **owner-agnostic** (`owner_user_id = null`); every admin/founder sees
   `scope = admin` threads via `portalInboxThreadScopeFilter`. The external sender
   is stored as `participant_email` as provenance.

The thread write runs **inline**, not in `after()`: a failed insert returns **500**
so Resend redelivers, instead of acking 200 and losing the support email. Only the
body enrichment (below) runs in `after()`.

No DB migration is required — this reuses the existing `portal_inbox_thread_records`
table and the `admin` inbox scope.

## Receive-only — SUPPORT replies do not reach the sender

The support inbox is **inbound display only**. Replying to a support thread in
the admin inbox calls `appendThreadReply`, which appends to `row.thread` and
persists it — it does **NOT** email the sender back. There is no outbound path
wired for these threads; answering a customer still means sending mail from the
support mailbox. Building an outbound round trip for SUPPORT threads is
deliberately out of scope. Portal conversation threads are different — their
round trip is the reply-token loop below.

## Conversation replies (`reply+` tokens)

The "manager replies on website ↔ resident replies from email" loop:

- **Outbound.** Both portal conversation send paths
  (`deliverPortalInboxMessage` in `src/lib/portal-inbox-delivery.ts` and
  `POST /api/portal/send-inbox-message`) send through
  `sendPortalConversationEmails` (`src/lib/portal-email-send.server.ts`): one
  personalized payload per recipient (never a shared `to:` array — that used to
  leak broadcast recipients to each other), sent via `POST /emails` for one
  recipient or `POST /emails/batch` in chunks of 100. Each payload carries:
  - `reply_to`: `reply+<sender-uuid-hex>.<mac-hex>@${RESEND_REPLY_DOMAIN}`
    (`src/lib/inbound-email/reply-address.server.ts`). The MAC (HMAC-SHA256,
    key = `RESEND_INBOUND_WEBHOOK_SECRET`, domain-separated input) binds the
    PAIR (sender user id, recipient email) — a leaked address only lets mail be
    injected into that one thread, as that one counterparty. Both halves are
    lowercase hex on purpose: mail software lowercases local parts, so a
    case-sensitive encoding would be corrupted in transit.
  - `In-Reply-To`/`References`: a deterministic synthetic per-pair anchor
    (`conversationAnchorMessageId`) so consecutive portal emails group in the
    recipient's mail client with no persisted Message-ID chain.
- **Inbound.** The webhook checks `parseReplyAddress(toEmails, fromEmail)`
  BEFORE the support ingest. A verified token routes to
  `ingestInboundEmailReply` (`src/lib/inbound-email/inbound-email-reply.server.ts`),
  which appends the reply to BOTH sides of the person-thread via
  `deliverPortalMessageThreadSide` — the token owner's inbox copy (unread,
  inbound, plus a best-effort push) and the replier's own copy (outbound) — with
  quoted history stripped (`stripEmailReplyQuote`). Anything that fails
  verification (foreign domain, tampered MAC, a From the MAC wasn't bound to,
  an owner whose profile no longer resolves) falls through to the admin support
  ingest: visible, never trusted, never lost.
- **Durability mirrors the support path.** The append runs inline from webhook
  metadata (placeholder body when Resend sent metadata only; a failed write
  500s so Resend redelivers) and `backfillInboundEmailReplyBody` swaps in the
  real body in `after()`, only ever overwriting the placeholder. Idempotency is
  the deterministic message id `email_<resend-email-id>` —
  `deliverPortalMessageThreadSide` skips an append whose id already landed
  (`rootMessageId` covers the created-thread case), which also makes a
  redelivery after a partial one-of-two-rows append safe.
- **Feature gate.** Unset `RESEND_REPLY_DOMAIN` → no Reply-To is added and no
  token ever validates. (Per-recipient sends and the anchor headers still apply
  — they are unconditional, and per-recipient is what fixed the old shared
  `to:` recipient-list leak.) Rotating `RESEND_INBOUND_WEBHOOK_SECRET`
  invalidates reply addresses in old emails — those replies fall to the admin
  inbox rather than being lost.
- **Accepted residuals.** (1) From-spoofing: the MAC proves possession of a
  reply address, and the counterparty is the MAC-bound From — but From is
  sender-chosen, so someone who OBTAINS a reply address (a forwarded email) can
  inject a message into that one thread as that one counterparty. Resend's
  `email.received` payload carries no SPF/DMARC verdict to gate on; if one
  appears, check it in the reply branch before trusting From. Content is
  untrusted display text either way. (2) A legit reply sent from a different
  address than the one emailed (alias/forwarder) fails the pair MAC and lands
  in the admin support inbox — visible there, but the manager's thread does not
  get it.
- Tests: `tests/unit/email-reply-address.test.ts`,
  `tests/unit/portal-email-send.test.ts`,
  `tests/unit/inbound-email-reply.test.ts`, and the routing cases in
  `tests/unit/inbound-email-webhook.test.ts`.

### Signature verification

Resend signs every webhook with Svix (`svix-id`, `svix-timestamp`,
`svix-signature`; secret `whsec_…`). We verify manually with node crypto
(`src/lib/inbound-email/verify-signature.ts`) rather than adding the `svix` SDK —
same choice as the inline Twilio verification. Signed content is
`${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the base64-decoded
secret, base64 output; any `v1,<sig>` entry in the header may match; the timestamp
is checked within a 5-minute tolerance to blunt replay.

### Idempotency

The thread id is deterministic: `inbound_email_<resend-email_id>`. Ingest
**inserts** that id and treats a unique-constraint violation as an already-ingested
no-op, so a retried (or concurrently redelivered) webhook never duplicates a thread
nor clobbers an admin's read/reply state. Any other database error throws and the
route answers 500 so Resend retries. Do not turn this back into a
read-then-upsert — the gap between the check and the write is exactly where a
concurrent redelivery overwrites `read`/`thread`.

### Body retrieval — write first, enrich second

Resend inbound webhooks are **metadata-only** (from/to/subject/id — no body). The
body is fetched from Resend's received-email API with the same `RESEND_API_KEY`
used for outbound, and that fetch is **best-effort** with an 8s timeout.

The order matters and is deliberate:

1. `ingestInboundEmail` inserts the thread from metadata alone, with
   `INBOUND_EMAIL_BODY_PLACEHOLDER` as the body. **That is what the split buys:** a
   hung or failing body lookup can never cost us the email, and the ≤8s fetch stays
   off the webhook response path (an over-long response makes Svix record a failed
   delivery). Do not resolve the body before the insert again.
2. `backfillInboundEmailBody` then runs in `after()`, in three steps whose ORDER
   is the load-bearing part:
   - **pre-check read** — bail unless the stored body is still exactly the
     placeholder, so an already-enriched thread costs no Resend round trip;
   - **lookup with a bounded retry** — up to 3 attempts, ~500ms then ~1s apart,
     each keeping its own 8s timeout;
   - **fresh re-read, then the guarded `UPDATE`** — the snapshot written back is
     re-read *after* the slow lookup, and the `UPDATE` re-checks the placeholder
     in its own `WHERE`.

   Keep the lookup outside that read→write pair. Moving it in between (which a
   previous revision did) leaves the snapshot up to ~25s stale before it is
   written back, which turns the accepted residual below into a real clobber.

The retry only fires on a **transient** failure. `fetchResendReceivedEmailBody`
returns a discriminated result — `body` / `empty` (HTTP 200 with no text or html
part, e.g. attachment-only) / `no-key` (`RESEND_API_KEY` unset, no request issued)
/ `error` — and only `error` is retried, so a body-less email never costs three
round trips and a missing key never costs 1.5s of sleeping inside `after()`.

That retry is load-bearing, not belt-and-braces: the route acks **200**, so Resend
does **not** redeliver, and nothing else will come along later to fill in a body
that a transient blip lost. A redelivery only happens if the insert itself 500s.

Known residual: the `UPDATE` writes back the `row_data` snapshot from the fresh
re-read one round trip earlier, so an admin who marks the thread read (or replies)
inside that sub-second window on a brand-new row would have it undone. Accepted —
recoverable, not lost mail, and closing it needs a jsonb-merge RPC plus the
migration this feature deliberately ships without.

If Resend routes received mail through a different API base for your account, set
`RESEND_INBOUND_API_BASE`.

## Captain-side setup (infra to provision)

The code is ready; these steps must be done in the Resend dashboard + DNS:

1. **MX / inbound routing for `support@prop-lane.space`.**
   Resend Dashboard → **Receiving** → copy the receiving address, then add the
   shown **MX record**. Recommended: point MX at a **subdomain**
   (e.g. `inbound.prop-lane.space`) and forward `support@prop-lane.space` to the
   receiving address, so existing root-domain MX for other mail stays intact.
   > ⚠️ Pointing the **root** `prop-lane.space` MX at Resend captures **all** mail
   > for the domain. Only do that if no other mailbox needs root-domain mail.
2. **Webhook.** Resend Dashboard → **Webhooks** → add endpoint
   `https://www.prop-lane.space/api/webhooks/email/inbound`, subscribe the
   **`email.received`** event, and copy the endpoint's **signing secret** (`whsec_…`).
3. **Secret.** Set `RESEND_INBOUND_WEBHOOK_SECRET=<whsec_…>` in Vercel (Production,
   and Preview if you want staging to accept inbound). Confirm `RESEND_API_KEY` is
   already set (used to fetch the email body).

4. **Conversation replies (optional).** Add the reply subdomain (e.g.
   `in.prop-lane.space`) to Resend **Receiving** with its own MX record, and set
   `RESEND_REPLY_DOMAIN=<that subdomain>` in Vercel. Until it is set, outbound
   conversation emails carry no Reply-To and the reply loop stays dark.

Until `RESEND_INBOUND_WEBHOOK_SECRET` is set in a deployed environment, the route
**rejects all inbound** (fail-closed) — that is intentional.

## Tests

`tests/unit/inbound-email-webhook.test.ts` — signature accept/reject (tamper, wrong
secret, replay, multi-signature), payload parsing, admin-scope row shape, a valid
inbound email creating an admin-scope thread, and idempotent re-delivery.
