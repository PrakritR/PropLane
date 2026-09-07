# Manual payment detection (Zelle / Venmo) — RETIRED, code intact

> **Not reachable in the product today.** Zelle and Venmo were retired as
> resident payment rails: residents pay through PropLane/Stripe only, the
> manager settings normalize both channels off, and Payment setup no longer
> offers **Link Zelle** / **Link Venmo**. See
> [`resident-payments.md`](resident-payments.md) § "A resident pays through
> PropLane only". Gmail receipt matching is additionally gated by
> `GMAIL_PAYMENTS_ENABLED` (`src/lib/gmail-payments/enabled.ts`, `false`), whose
> header comment carries the OAuth restricted-scope reason; the connect routes
> and the `GmailPaymentAutoTrackPanel` both refuse while it is off.
>
> Nothing below was deleted — the parsers, the matcher, the cron and the stored
> connections are all still there, so turning the rails back on is a settings
> and flag change rather than a rebuild. Read the rest of this file as the
> architecture reference for that code, not as a description of live behaviour.

How PropLane decided a Zelle or Venmo charge was **paid** from the manager's
own payment-notification emails, and the setup a manager and resident each did.

## The two detection paths

| Path | Trigger | Latency |
| --- | --- | --- |
| **Linked Gmail** | Resident taps **Check payment** (`resident-check-manual-payment.server.ts`); the manager's Payments tab scans on its own (`POST /api/portal/gmail-payments/sync` — once on arrival, then on a timer, while the tab is visible and there are open charges to match; there is no **Check** button to press) | `GET /api/cron/sync-manual-payments` runs once daily on Vercel Hobby (managers with rent due in 48h are prioritized inside each run) |
| **Forwarded email** (`payments+<token>@…`) | A Gmail filter forwards receipts; the inbound webhook processes each on arrival | Instant |

Both paths run the SAME parse → match → mark-paid pipeline
(`src/lib/payment-receipt-email/`). Only genuine receipts are trusted: the
sender host must be Venmo/Zelle (or an allow-listed bank for Zelle,
`BANK_RECEIPT_DOMAINS`) — a mere mention of "venmo"/"zelle" in the body from an
untrusted host is rejected. The email must also read as **money received**
(`receiptIndicatesInboundPayment`: "X paid you" / "sent you" / "you received" /
"received $… from Y" in the subject or the top of the body); payment requests,
request reminders, statements/transaction history, and outbound
"You paid / You sent" notices are rejected before matching — even with a `PL-`
code — because a request note is payer-controlled and none of them mean money
arrived. The reject words are checked against the **subject line only**: real
receipt bodies legitimately contain them ("If you didn't request this
transfer", "view your statement"), and body boilerplate must never veto a
genuine receipt.

## Matching — two tiers, biased to safety

A receipt is matched against the manager's **pending / failed / partially_paid**
charges. Amounts, identity, and the reference come only from the receipt; the
model never invents a match.

1. **Reference code (strong).** If the resident put the charge's
   `PL-XXXXXX` code in the memo, we match that exact code + amount. A code that
   resolves to nothing is `no_match` — never re-attributed by fuzzy fallback.
2. **Reference-less fallback (`receipt-fallback-match.ts`).** Real people write
   "Application fee for room 5 at 5257 Brooklyn avenue" with no code. We match on
   **amount plus an identity signal — payer name and/or property/unit context**
   (either signal suffices; each has its own bar):
   - A payer-name signal requires **two distinct tokens (first + last)** shared
     with the resident on file.
   - A property signal needs the **street number _and_ a distinctive word** from
     the listing label in the memo (a generic "avenue" alone never matches).
   - Auto-mark only when **exactly one** charge has the amount and at least one
     identity signal. Otherwise the receipt is counted **`ambiguous`** and the
     charge simply stays **pending** for the manager to mark paid manually —
     there is no approval queue, and nothing is credited. **Amount alone never
     auto-credits.** A wrong auto-credit is worse than leaving a charge pending.

**Idempotency:** the source email id is written onto the charge
(`paidViaGmailMessageId` / `paidViaEmailReceiptId`); re-processing the same
receipt returns `idempotent` and never double-credits, and one payment is
applied to at most one charge.

## Setup steps

### Manager (once per channel)
1. **Choose properties, then save your Zelle/Venmo contact** — Zelle accepts a phone number (usual) or email. The saved destination is applied only to those listings and their pending charges, so the resident screen and application flow use the same current destination.
2. **Turn on payment-received email notifications** in Zelle/your bank app or
   the Venmo app.
3. **Link the Gmail inbox for each channel** (read-only receipt scope) *or* set up a **forwarding filter**
   to `payments+<token>@prop-lane.space` for instant detection. Zelle and Venmo can use different Gmail
   accounts. If Google shows **“This app is blocked”** on Link Gmail (`gmail.readonly` is a restricted
   scope), skip Step 3 and use forwarding — it uses the same matching pipeline.
4. **Auto-mark charges paid** toggle — on by default.

### Resident (shown on the charge, resident Payments)
- Pay the manager's Zelle/Venmo contact for the exact amount.
- **Include the `PL-XXXXXX` code** shown on the charge in the memo/note — fastest,
  most reliable match. The resident Payments panel surfaces this code on every
  Zelle/Venmo charge (`chargePaymentReference`), copy-to-clipboard.
- No code? We still match from the payer's name + the property, but the code is
  fastest.

### Detection timing
- **Forwarded email:** matched the moment the receipt lands.
- **Linked Gmail:** matched when a resident taps **Check payment**, when the manager's Payments tab runs its automatic scan (on arrival and on a timer), or on the daily cron scan.
- Anything we can't confidently attribute is counted **ambiguous** and left
  alone — the charge stays pending for the manager to mark paid manually, and
  is never silently credited.

## Tests
- `tests/unit/receipt-fallback-match.test.ts` — name/property/amount matching.
- `tests/unit/payment-receipt-email.test.ts` — parser incl. reference-less real
  Venmo shape + payer-name extraction.
- `tests/unit/mark-charge-from-receipt.test.ts` — end-to-end mark-paid from the
  real receipt shape, ambiguity, and idempotency (same receipt twice).
