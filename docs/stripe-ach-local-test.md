# Local ACH testing (Stripe test mode)

Use this guide to test **resident rent/utilities** bank payments on `http://localhost:3000` without charging real money. Rental **application fees** no longer use ACH — that checkout is card / Apple Pay ([`stripe-apple-pay-payments.md`](stripe-apple-pay-payments.md)); test it with card `4242…`, since wallets never appear on `localhost`.

## 1. Switch `.env.local` to test mode

In [Stripe Dashboard](https://dashboard.stripe.com), turn **Test mode ON** (top right).

**Developers → API keys** — copy into `.env.local`:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000

STRIPE_SECRET_KEY=sk_test_…
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…   # from step 2 below
```

Keep Supabase vars as-is. Subscription price IDs must be **test** `price_…` IDs (run `npm run stripe:setup-plans` after setting `sk_test_…`).

> **Important:** All Stripe vars in one file must be test mode (`sk_test_` + `pk_test_` + test prices). Do not mix live keys with test prices.

Validate:

```bash
npm run stripe:validate
```

Restart the dev server after any env change.

## 2. Forward webhooks locally

ACH payments often complete asynchronously. Webhooks mark charges paid when Stripe confirms.

```bash
# Terminal 1
npm run dev

# Terminal 2 (requires Stripe CLI)
stripe login
npm run stripe:listen
```

Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` in `.env.local`, then restart `npm run dev`.

`stripe listen` forwards at minimum:

- `payment_intent.processing` ← the bank debit was submitted
- `payment_intent.succeeded` ← required for ACH clearing
- `payment_intent.payment_failed`
- `checkout.session.completed` / `checkout.session.async_payment_succeeded`
  (the card rail and the vendor-invoice / application-fee Checkouts)

## 3. Stripe Dashboard (test mode)

1. **Connect** — [Connect overview](https://dashboard.stripe.com/test/connect/accounts/overview) → complete platform Connect setup if prompted.
2. **Payment methods** — **Settings → Payment methods** → enable **ACH Direct Debit**.

## 4. Manager: connect payouts (test)

1. Sign in as a **manager** on `http://localhost:3000`.
2. Open **Portal → Payments**.
3. Complete **Stripe Connect** onboarding (test data is fine).
4. Wait until status shows transfers/payouts ready.

Each manager gets a test Connect account stored in `profiles.stripe_connect_account_id`.

This step is **not** a precondition for the resident's payment — it decides when
the money leaves PropLane, not whether it can be collected. A resident can pay
before the manager finishes payout setup: the payment is captured centrally and
held as a verified source, then transferred once Connect and a bank are ready.
Do this step when you want to watch the transfer and withdrawal too.

## 5. Enable PropLane payments on a property

When adding or editing a listing, turn on **PropLane payments with Stripe**.

That listing checkbox is the only gate on residents seeing “Bank (ACH)”.

## 6. Create a charge to pay

As **manager**: add a household charge (rent, utility, etc.) for a resident email that has a resident login.

As **resident**: sign in with that email → **Payments** → **Bank (ACH)**.

## 7. Test bank account (in-app form, no Checkout)

Resident rent by bank is PropLane's **own** form, not Stripe Checkout: the
browser hands the routing and account numbers straight to Stripe.js
(`confirmUsBankAccountPayment`) and the server only ever sees the PaymentIntent
id. Use Stripe’s test US bank account:

| Field | Value |
|-------|--------|
| Routing | `110000000` |
| Account | `000123456789` |

- **Microdeposit verification:** the PI comes back `requires_action` with
  `verify_with_microdeposits`. The in-app verification step takes either the
  `SM…` descriptor code or the two deposit amounts; in test mode use the values
  from [Stripe's microdeposit testing table](https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment#test-account-numbers).
- **Processing:** the charge sits on “submitted” until the debit clears. In test
  mode you can advance it from the Dashboard, or trigger the event by CLI:

```bash
stripe trigger payment_intent.succeeded
```

(Use a real PaymentIntent id from your test payment when debugging webhooks.)

Closing the sheet does not lose the attempt: **Verify bank or check status**
reopens the exact original PaymentIntent by `GET`, and never starts a second one.

## 8. What to verify

| Step | Expected |
|------|----------|
| Bank form opens | PropLane's own form in-page, never a redirect; card opens embedded Checkout with a **TEST MODE** badge |
| Return URL | Stays on `localhost:3000`, not Vercel |
| Webhook | Terminal running `stripe:listen` shows events |
| Resident Payments | Charge moves to **Paid** after webhook |
| Manager Payments | PropLane balance shows the held amount; it transfers once Connect + bank are ready |

## Troubleshooting

| Error | Fix |
|-------|-----|
| `STRIPE_NOT_CONFIGURED` | Set `STRIPE_SECRET_KEY` in `.env.local`, restart dev |
| `MANAGER_NO_CONNECT_ACCOUNT` | Manager completes Portal → Payments Connect |
| `AXIS_PAYMENTS_DISABLED` | Enable **PropLane payments with Stripe** on the property listing |
| Webhook never fires | Run `npm run stripe:listen`, update `STRIPE_WEBHOOK_SECRET`, restart dev |
| Live keys locally | Switch to `sk_test_` / `pk_test_` for local ACH tests |

## Keep production separate

| | Local | Vercel production |
|---|--------|-------------------|
| Keys | `sk_test_` / `pk_test_` | `sk_live_` / `pk_live_` |
| Webhook | `stripe listen` `whsec_…` | Dashboard live endpoint `whsec_…` |
| App URL | `http://localhost:3000` | `https://axis-2.vercel.app` |
