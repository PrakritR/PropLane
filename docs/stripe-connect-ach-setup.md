# Stripe Connect + ACH setup (resident portal payments)

ACH bank transfers are **only** for resident rent/utility payments. Rental **application fees** are paid online by card / Apple Pay / Google Pay — see [`stripe-apple-pay-payments.md`](stripe-apple-pay-payments.md). Manager Pro/Business subscriptions use **card**, not ACH.

## Architecture

```
Resident pays rent at face value (no processing/service fee — any method)
    → Stripe Checkout (us_bank_account)
    → Connect DESTINATION charge on the platform account, no application_fee_amount
    → Full charge subtotal transferred to manager Connect account (acct_…)
    → PropLane's platform balance bears Stripe's processing cost
    → Manager receives payout to their linked bank
```

Fee model (who pays what): see [`docs/agents/resident-payments.md`](agents/resident-payments.md).

Each manager gets a **Stripe Connect Express** account stored in `profiles.stripe_connect_account_id`.

### In-app payouts (PLAN-0920-0853) — Account Links and the Express dashboard are gone

Identity verification and bank linking, and paying out and setting a schedule,
all happen on PropLane's own **Payments → Payouts** page
(`/portal/payments/payouts`, vendor twin `/vendor/financials/payouts`) — never
a redirect to `connect.stripe.com` and never the Express Dashboard login link.
`src/app/api/stripe/connect/onboard/route.ts` (and its vendor twin) only
ensure a Connect account exists and report its readiness; the client mounts
Stripe's `account_onboarding` / `account_management` embedded components
inside PropLane's own modal chrome using a client secret from
`POST /api/stripe/connect/account-session` (`src/lib/stripe-connect-embedded.ts`).

Balance, "Pay out" and the payout schedule are their own routes:
`GET /api/stripe/payouts/balance`, `POST /api/stripe/payouts/create`,
`PUT /api/stripe/payouts/schedule` (vendor twins under `/api/vendor/payouts/`).
Pure eligibility/fee/schedule logic lives in `src/lib/stripe-payouts.ts`; the
Stripe/DB reads and the idempotent claim-before-call payout creation (same
pattern as `payoutVendorForWorkOrder`) live in `src/lib/stripe-payouts.server.ts`.

**Instant Payouts** must be turned on once for the platform in the Stripe
Dashboard (Connect → Instant Payouts) before any connected account can use the
Instant speed — this is a Stripe Dashboard setting, not a code change. Stripe
charges a flat **1% fee** on every Instant Payout
(docs.stripe.com/connect/instant-payouts); PropLane passes that fee straight
through and adds no markup (Decide 2). A newly linked bank defaults to
**automatic weekly payouts (Friday)** (Decide 1); "Pay out" remains available
at any time regardless of the schedule.

### Bank accounts, fully in-house (PLAN-0920-1500) — Stripe.js tokens, never a raw number

The "Bank accounts" section of Settings → Payouts (and the "Add a bank
account" sheet) never sends a routing number, account number, card number, or
CVC to PropLane's server. Every add path tokenizes in the browser with
[Stripe.js](https://docs.stripe.com/js) (`@stripe/stripe-js` /
`@stripe/react-stripe-js`, needs `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`), and the
server only ever receives a token id or a Financial Connections account id:

- **Link instantly** (recommended) — `POST /api/stripe/connect/financial-connections/session`
  creates a Financial Connections Session scoped to the manager's own Connect
  account (`account_holder: { type: "account", account: acctId }`,
  `permissions: ["payment_method"]`); the client opens Stripe's linking modal
  in-page with `stripe.collectFinancialConnectionsAccounts({ clientSecret })`
  (never a new tab), then `POST /api/stripe/connect/financial-connections/attach`
  turns the linked account into a payout destination.
- **Routing + account number** — the browser calls
  `stripe.createToken("bank_account", { routing_number, account_number, … })`
  and posts only the resulting `btok_…` id to
  `POST /api/stripe/connect/bank-accounts`. Micro-deposit verification (when
  Stripe requires it) is `POST /api/stripe/connect/bank-accounts/:id/verify`
  with the two deposit amounts in cents.
- **Debit card for Instant payouts** — a Stripe Elements `CardElement` collects
  the card, `stripe.createToken(cardElement)` returns a `tok_…` id posted to
  the same `bank-accounts` route. The server rejects (422) any card whose
  `funding` is not `debit`.

`src/lib/stripe-external-accounts.server.ts` owns every server-side call
(list / add / set-default / remove / verify) plus the `payout_destinations_cache`
display cache, refreshed after every mutation and by the
`account.external_account.created|updated|deleted` webhook
(`handleExternalAccountEvent` in `src/lib/stripe-webhook-financials.ts`) —
Stripe itself always stays the source of truth; the cache exists only so a
future surface can show a fast, non-authoritative list. Removing an account is
refused (409) while it is the ONLY destination and a payout is pending or in
transit. Vendor twins live under `/api/vendor/stripe-connect/…`.

---

## Part A — Platform setup (you, once)

### A1. Stripe Dashboard — activate Connect

1. [Stripe Dashboard](https://dashboard.stripe.com) → **Connect** → **Get started**.
2. Complete platform profile (business name, support email, etc.).
3. Choose **Express** connected accounts (Axis creates these for managers).

### A2. Enable ACH on the platform

**Settings → Payment methods** → enable **ACH Direct Debit** (US bank accounts).

### A3. Local `.env.local` (test mode recommended)

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000

NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…

STRIPE_SECRET_KEY=sk_test_…
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…   # from `npm run stripe:listen`
```

Subscription price IDs (`STRIPE_PRICE_*`) are for manager plans only — not required for ACH resident payments.

Validate: `npm run stripe:validate`

### A4. Supabase migration

Run in SQL Editor if not already applied:

`supabase/migrations/20250421120000_profiles_stripe_connect_account.sql`

### A5. Webhooks (local)

```bash
# Terminal 1
npm run dev

# Terminal 2
stripe login
npm run stripe:listen
```

Copy `whsec_…` → `STRIPE_WEBHOOK_SECRET` → restart dev server.

Required events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `account.external_account.created`, `account.external_account.updated`, `account.external_account.deleted` (bank/card cache refresh)

---

## Part B — Manager Connect onboarding (each manager)

1. Sign in as manager → **Portal → Payments → Payouts** (`/portal/payments/payouts`).
2. Complete embedded Stripe onboarding (identity, business info, **bank account for payouts**).
3. Wait for badge **Payouts ready** (transfers + payouts active).

Until this is done there is no rail a resident can pay on, so checkout is refused and the resident is told to ask the manager to finish payment setup.

---

## Part C — Property + resident setup

### C1. Enable PropLane payments on listing

**Properties → edit listing → Resident payment methods** → check **PropLane payments with Stripe**. One checkbox enables both rails: rent by bank (ACH), card, or Link, and the application fee by card / Apple Pay.

### C2. Manager creates a charge

**Portal → Payments → Add payment** (rent, utility, etc.) for the resident’s email.

### C3. Resident pays

**Resident portal → Payments → Pay with bank (ACH)**.

Test bank (Stripe test mode):

| Routing | Account |
|---------|---------|
| `110000000` | `000123456789` |

---

## Part D — Production (Vercel)

Same keys pattern with **live** mode:

| Variable | Source |
|----------|--------|
| `STRIPE_SECRET_KEY` | `sk_live_…` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | Live webhook endpoint (not `stripe listen`) |
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.com` |

Live webhook URL: `https://your-domain.com/api/stripe/webhook`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| “Stripe Connect is not activated” | Finish Connect setup in Dashboard (Part A1) |
| Demo / keys missing message | Set `STRIPE_SECRET_KEY` + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, restart dev |
| `MANAGER_NO_CONNECT_ACCOUNT` | Manager completes Payouts onboarding |
| `AXIS_PAYMENTS_DISABLED` | Enable **PropLane payments with Stripe** on the property listing |
| Charge stays pending after ACH | Check `stripe listen` + webhook secret |
| Restricted Connect account | Manager completes outstanding requirements in Payouts |
