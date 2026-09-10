# Manager communication credit

Free, Pro and Business all include a work number and Communication access. Provisioning,
phone verification, carrier registration, consent and runtime rollout controls still apply.
The phone itself has no setup or monthly usage deduction. Assistant email retains its
separate paid-plan entitlement (`preferPaid: true`).

| Plan | Subscription | Monthly retail communication credit |
| --- | --- | --- |
| Free | $0 | $2 |
| Pro | $20/month or $192/year | $10 |
| Business | $200/month or $1,920/year | $100 |

Annual subscriptions receive the same monthly credit. Credit resets on the first of
each month at 00:00 UTC. Existing managers keep their higher current allowance during
the migration month; the new allowance starts next reset. An upgrade adds only the
positive allowance difference once; downgrades take effect at the next reset.

The paid allowance is 50% of monthly subscription price in **retail usage credit**,
not provider cost. Rates include operational overhead; provider and carrier costs can
vary. Free's $2 buys at most 66 outbound single-segment texts, Pro 333 and Business
3,333 if used only for that meter. Incoming messages, voice and AI share the same balance.

## Purchases and stops

Manual one-time packs: **$5, $10, $25, $50**. Purchased credit carries forward without
expiry and is spent after included credit. A saved card never authorizes automatic
recharge or overage. Insufficient credit blocks new outgoing SMS, calls and work-number
AI. Incoming SMS is stored first and uses available credit only; unavoidable excess
is absorbed by PropLane. Message history and the assigned number remain available.

`COMMS_PAYG_BILLING_ENABLED=1` now enables **manual credit checkout only**. It defaults
off until the migrations and signed Stripe webhook are available. The former
`COMMS_LIMITS_ENFORCED` flag cannot disable credit enforcement. The old invoicing cron
and invoicing helper return a retired/no-op response; they never invoice usage.

Web checkout uses Stripe. The native app shares balances and communication, but does
not show Stripe checkout or an external purchase link. Apple consumable products and
RevenueCat fulfillment need separate setup before native top-ups can be offered; see
`apple-iap.md`. This does not restrict credit already bought on the web.

## Retail rates (USD)

| Meter | Rate |
| --- | --- |
| Outbound SMS segment | $0.03 |
| Inbound SMS segment | $0.02 |
| Voice minute | $0.04 |
| Speech recognition gather | $0.05 |
| AI agent turn | $0.15 |
| Recording minute | $0.01 |
| Work number setup and monthly rental | Included separately |

SMS may span several segments. Voice and recording round up to minutes. Voice reserves
at most five minutes (fewer when funds require) and applies that bound to the active
Twilio call before answering. Recognition and AI reserve separately before work starts.
Terminal callbacks return unused duration; recording settlement waits for its own
callback or an authoritative provider check that recording never started.

## Data and authorization

Apply `20260910140000_manager_communication_credits.sql` and
`20260910160000_comms_credit_alerts.sql` after the original billing migration. New
wallet/purchase RPCs and tables are service-role-only. Canonical
`getEffectiveManagerSkuTier` supplies every quota; unreadable plans fail closed.

- `GET /api/manager/comms-billing`: read-only balance, usage, rates and recent purchases.
- `PATCH /api/manager/comms-billing`: `{ monthlyBudgetCents }`, alert only. Cannot clear a pause.
- `POST /api/manager/comms-billing/checkout`: server-priced pack and UUID operation id;
  owner derives from authenticated manager context. Co-manager access grants no spending authority.
- Signed `/api/stripe/webhook`: exact paid amount, USD, purpose, checkout identity and
  owner checks before atomic credit fulfillment. Duplicate events grant once. Refunds
  reconcile cumulatively; disputes remove credit and pause for staff review. Won disputes
  remain under staff review rather than silently restoring spendable credit.
- Budget alerts claim 80%/100% once per UTC month atomically, without loading all usage
  into the delivery process. A card update cannot clear a credit-reversal pause.

All outgoing manager-funded SMS uses the work-number dispatcher. The central transport
checks an owner-scoped reservation; authenticated phone verification is the sole
platform-funded exemption. Pooled legacy relay routing is retired. Vendor sessions are
scoped by both sender phone and destination work-number owner before prospect routing.

Model-turn completion is persisted against the reservation before delivery. Replays
reuse it. A turn interrupted for more than ten minutes produces an explicit terminal
notice instead of repeating tools; the manager must inspect existing portal actions.
Unknown carrier submissions retain their debit and enter operator reconciliation,
never automatic resend. Confirm provider outcome before releasing any such reservation.

Processing fees are separate from communication credit and from every subscription.
Only the staff-owned account override grants PropLane processing coverage. See
`resident-payments.md`.

## Verification

`tests/integration/comms-credit-postgres.test.ts` exercises real local PostgreSQL
concurrency, monthly resets, upgrades, grandfathering, fulfillment/reversals and staff
ownership. Set `COMMS_CREDIT_TEST_DATABASE_URL` to a disposable **localhost** database;
remote URLs are rejected. Unit tests cover purchase authorization and price integrity,
fee precedence, plan copy and messaging boundaries. Use Stripe **test mode** and the
dev/test database for browser checkout verification; never production data.
