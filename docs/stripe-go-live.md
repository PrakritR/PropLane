# Stripe go-live (real payments)

The **TEST MODE** badge on Checkout means your app is using **test keys** (`sk_test_…`, `pk_test_…`). No code change is required to accept real money — you switch keys, prices, and webhooks in Stripe and your hosting env.

## 1. Complete Stripe account activation

In [Stripe Dashboard](https://dashboard.stripe.com), finish **Activate your account** (business details, bank account for payouts). Live charges are blocked until activation is complete.

## 2. Turn off Test mode

Dashboard top-right: toggle **Test mode → OFF**. You are now in **Live mode**.

## 3. Create live products and prices

**Product catalog → Add product** (live mode):

| Product | Monthly | Annual |
|---------|---------|--------|
| Axis Pro | $20/mo | $192/yr |
| Axis Business | $200/mo | $1,920/yr |

Or, with your **live** secret key in `.env.local`:

```bash
# Temporarily set STRIPE_SECRET_KEY=sk_live_… in .env.local only (never commit)
npm run stripe:setup-plans
```

Copy the four `price_…` IDs — they are **different** from test mode price IDs.

## 4. Live API keys

**Developers → API keys** (live mode):

| Env var | Value |
|---------|--------|
| `STRIPE_SECRET_KEY` | `sk_live_…` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` |

## 5. Live webhooks (production): TWO endpoints, one route

PropLane receives Stripe events at **one route** (`/api/stripe/webhook`) but Stripe signs each **endpoint** with its **own** signing
secret, and the route accepts either (`STRIPE_WEBHOOK_SECRET` or `STRIPE_CONNECT_WEBHOOK_SECRET`; it tries each, compares
signatures in constant time, and rejects the event if neither verifies). A Connect-only event (signed by the Connect secret) is
processed only when it names its account (`event.account`) and is one of the connected-account types below; anything else on that
endpoint is acknowledged and ignored. **Without the Connect endpoint, `account.updated` / `account.external_account.*` / `payout.*`
for owners', vendors' and managers' Connect accounts are never delivered: held money does not release when an account becomes
payout-ready, and the "payouts ready" text is never sent.**

**Developers → Webhooks → Add endpoint** (live mode), twice:

| | Endpoint 1: Platform | Endpoint 2: Connect |
|---|---|---|
| URL | `https://proplane.ai/api/stripe/webhook` | `https://proplane.ai/api/stripe/webhook` |
| "Listen to" | **Events on your account** | **Events on Connected accounts** |
| Signing secret → env | `STRIPE_WEBHOOK_SECRET` | `STRIPE_CONNECT_WEBHOOK_SECRET` |

Endpoint 1 events:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
- `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`
- `charge.refunded`, `refund.created`, `refund.updated`
- `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`
- `transfer.created`, `transfer.reversed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `invoice.paid`, `invoice.payment_failed`

Endpoint 2 events (connected accounts only):

- `account.updated`
- `account.external_account.created`, `account.external_account.updated`, `account.external_account.deleted`
- `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`

Do **not** use `stripe listen` signing secrets in production; those are for local test forwarding only.

**Backstop cron.** `/api/cron/release-ready-holds` (every 15 minutes, `CRON_SECRET` bearer, in `vercel.json`) reads the Connect
account of every owner who has verified held money and, when it can receive payouts, applies it exactly as the `account.updated`
webhook would (readiness flags, one "payouts ready" text on the transition, release of the held money). It is idempotent: a racing
webhook or a repeat run releases nothing twice. It exists for a lost event or a Connect endpoint that was down or missing a secret;
it does not replace Endpoint 2.

**Automatic vs manual payouts.** Owner and vendor withdrawals Transfer to the person's own Express account and, when that account
is on a **manual** payout schedule, create the bank payout. When the account is on Stripe's **automatic** schedule the withdrawal
creates no payout (the money leaves with the account's next automatic payout, and the person is told so). Setting
`MANUAL_PAYOUT_POLICY_ENABLED=1` makes `account.updated` move Express accounts to the manual schedule; leave
`PROPLANE_BALANCE_ENABLED` as it is.

## 6. Billing portal

**Settings → Billing → Customer portal** (live mode): enable so managers can update cards and cancel from `/portal/plan`.

## 7. Apple Pay

Manager Pro/Business checkout **and** resident rent / rental-application-fee checkout support **Apple Pay** via Stripe dynamic payment methods. Domain registration is shared — register once and it applies to every wallet flow.

1. **Settings → Payment methods** — enable **Apple Pay** (and **Google Pay**).
2. Register domains:
   ```bash
   node --env-file=.env.local scripts/setup-stripe-apple-pay-domains.mjs
   ```
3. Test on Safari (HTTPS) at `/partner/pricing` or `/portal/plan`, and at `/resident/payments` / `/rent/apply`.

Full guides: [`docs/stripe-apple-pay-subscriptions.md`](stripe-apple-pay-subscriptions.md) (subscriptions) and [`docs/stripe-apple-pay-payments.md`](stripe-apple-pay-payments.md) (rent + application fees, incl. the optional `STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION`).

## 8. Update hosting (Vercel)

Project → **Settings → Environment Variables** → Production:

```
NEXT_PUBLIC_APP_URL=https://proplane.ai
STRIPE_SECRET_KEY=sk_live_…
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…           (live Endpoint 1: events on your account)
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_…   (live Endpoint 2: events on Connected accounts)
CRON_SECRET=…                           (Vercel sends it as the cron bearer)
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_ANNUAL=price_…
STRIPE_PRICE_BUSINESS_MONTHLY=price_…
STRIPE_PRICE_BUSINESS_ANNUAL=price_…
```

Redeploy after saving.

## 9. Validate

Locally (after updating `.env.local` with live keys):

```bash
npm run stripe:validate-live
```

All checks should pass and mode should report **live** (no TEST MODE badge at checkout).

## 10. Optional live promos

Recreate in **live mode** if you use them:

- `STRIPE_PROMOTION_CODE_ID_FIRST_MONTH_FREE` — FREEFIRST on Pro monthly
- `STRIPE_COUPON_SWITCH_TO_ANNUAL` — monthly → annual switch coupon

## Keep test mode for local dev

Recommended: keep **test keys** in local `.env.local` for development, and **live keys** only in Vercel Production. Never commit either set to git.
