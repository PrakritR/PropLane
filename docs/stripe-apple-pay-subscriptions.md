# Apple Pay for manager subscriptions

Manager **Pro** and **Business** subscriptions use **Stripe Checkout** (embedded on pricing / plan pages) **on the web**. Sessions are restricted to card funding and hide Link, avoiding redirect payment methods. Apple Pay can appear for eligible card sessions on registered domains; verify it on the actual device and browser. Inside the iOS app, the manager subscription is bought via **Apple In-App Purchase**, not Stripe — see [`docs/agents/apple-iap.md`](agents/apple-iap.md); this document covers the web checkout only.

## Architecture

| Layer | Location |
| --- | --- |
| Shared session builder | `src/lib/stripe/subscription-checkout-session.ts` |
| New signup checkout | `src/lib/stripe/manager-checkout.ts` → `/api/stripe/checkout` |
| Portal upgrade checkout | `/api/stripe/checkout-portal` |
| Embedded UI | `src/components/stripe-embedded-checkout.tsx` |

**Important:** All manager subscription sessions go through `buildManagerSubscriptionCheckoutBase()`, which sets `payment_method_types: ["card"]` and `wallet_options.link.display: "never"`. Do not pass an unvalidated dynamic payment method configuration that could add offsite methods.

## One-time Stripe Dashboard setup

1. **Settings → Payment methods** — turn on **Apple Pay** for card sessions if desired.
2. **Settings → Payment methods → Apple Pay** — complete any business verification Stripe requests.

## Register your domains

Apple Pay on Checkout requires each hostname to be registered with Stripe.

```bash
node --env-file=.env.local scripts/setup-stripe-apple-pay-domains.mjs
```

Uses `NEXT_PUBLIC_CANONICAL_APP_URL` and/or `NEXT_PUBLIC_APP_URL` (production hostnames only — not `localhost`).

Check validation status:

```bash
node --env-file=.env.local scripts/setup-stripe-apple-pay-domains.mjs --validate-only
```

Typical production domains:

- `prop-lane.space` (canonical origin — also what the app WebView loads)
- `www.prop-lane.space`
- `www.axis-seattle-housing.com` / `axis-seattle-housing.com` (legacy hosts, still live)

## Testing

| Environment | Apple Pay |
| --- | --- |
| `localhost` | Not available (use Stripe test card `4242…`) |
| Safari on macOS/iOS (HTTPS) | Yes, when domain is registered |
| Axis iOS app (Capacitor WebView) | N/A — the app buys the manager plan via Apple IAP, not Stripe checkout ([`docs/agents/apple-iap.md`](agents/apple-iap.md)) |
| Stripe test mode | Apple Pay test wallet in Safari |

1. Open `/partner/pricing` or `/portal/plan` on **Safari** (signed in for portal upgrade).
2. Start Pro/Business checkout — Apple Pay button should appear above card fields when eligible.
3. Complete with Apple Pay test card in Stripe test mode.

## Web + native

The Stripe subscription checkout is a **web-only** surface: on iOS the plan page shows the StoreKit/RevenueCat purchase surface instead, and never a web purchase link (App Store 3.1.1 — [`docs/agents/apple-iap.md`](agents/apple-iap.md)). Deploy to Vercel to ship web checkout changes; no App Store rebuild unless you change native shell code.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Only card fields, no Apple Pay | Enable Apple Pay in Dashboard; run domain setup script; use Safari/HTTPS |
| A redirect payment method appears | Confirm sessions use `buildManagerSubscriptionCheckoutBase()` with card-only funding |

## Related docs

- [`docs/stripe-go-live.md`](stripe-go-live.md) — live keys and webhooks
- [`SUPABASE_STRIPE_SETUP.md`](../SUPABASE_STRIPE_SETUP.md) — subscription flow overview
