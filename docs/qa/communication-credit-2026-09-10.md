# Communication credit and processing-fee coverage

Subscription prices remain Free / $20 / $200 monthly ($192 / $1,920 annual).
Monthly communication credit is $2 / $10 / $100. All tiers retain work-number and
Communication access. Processing fees are separate; only staff account approval
allows PropLane coverage. Manual credit packs are $5, $10, $25 and $50.

## Validation in this branch

- Full unit run: 1,369 files, 9,444 tests passed (exit 0), followed by focused
  checks after the final vendor-consent and incoming-owner fixes.
- PostgreSQL: 10 tests passed (exit 0), including concurrent reservations, duplicate
  paid fulfillment, refunds, UTC resets/upgrades, inherited allowance, atomic budget
  alerts and concurrent staff revocation versus manager preference saves.
- TypeScript and production build: exit 0. Changed-file ESLint: exit 0; existing
  warnings in listing/payment components and legacy settings remain.
- Real seeded manager at localhost:3013: Business coverage resolves false, current
  $150 allowance preserved with $100 next-month disclosure, invalid pack API returns
  400. Work-number and Communication UI remain accessible.
- Stripe **test mode**, dev/test database: actual $5 card checkout completed. Replaying
  its signed event twice yielded one $5 ledger adjustment. Actual $2 partial refund
  followed by two signed refund deliveries yielded one -$2 adjustment, leaving $3.
- Mobile web at 390px: no horizontal overflow; credit pack modal verified visually.
  UI tests cover zero balance, unreadable balance, pending redirect and native checkout
  restrictions. Browser console error collection was empty.
- Security review and Bugbot found no remaining high/P1 issues in their final spot-checks.

## Rollout and limitations

Only dev/test migrations were applied. Production and staging data are untouched.
Root migration history differed from dev/test history, so deployment used a temporary
Supabase workdir with the fetched remote history; dry-run listed only the new migrations.
No migration history was repaired or overwritten. Apply the two additive migrations
through the repository staging ladder before enabling manual checkout via
`COMMS_PAYG_BILLING_ENABLED=1`. This flag does not control credit enforcement.

Native balances are shared, but Apple consumable products/RevenueCat credit fulfillment
are not configured. The native app therefore exposes no Stripe checkout or external
purchase link. See `docs/agents/apple-iap.md` and the updated Lavish plan.

No real SMS was sent, no phone number was purchased and no live call was placed during
verification. Provider paths use existing number registration and runtime controls.
Unknown carrier submissions stay reserved for operator reconciliation; they never
resend automatically. Won disputes remain paused for staff review.

Local graph refresh completed with the repository's existing missing Swift-grammar
warning; portable-check passed. The installed hook did not create a TypeScript runtime
marker. No graph lifecycle files were added to git.

## Billing & plan follow-up

The credit panel, rates/history and budget alerts now live in Billing & plan.
Communication settings contains work-number setup only. Payment methods uses Stripe
Checkout setup mode; adding a card collects no payment. Default selection applies
to the manager's customer and active subscription, without automatic credit recharge.
Financial identity is linked by authenticated user ID, never the entitlement loader's
legacy email fallback. Conflicting customer/subscription identities fail closed.

Dev/test migration `20260910170000_manager_billing_customer.sql` was applied through
the isolated migration workdir; no production writes. Stripe test-mode browser
verification on port 3014 saved Visa 4242 (12/2030) through the embedded setup form,
returned to Billing & plan and selected that card as default. Stripe confirmed the
completed session had `mode=setup` and no PaymentIntent, and the selected default
matched the API response. Existing purchased credit remained 300 cents. An uncompleted
$5 credit checkout used that same customer and retained the separately confirmed
payment flow. The saved card has `allow_redisplay=always`.

Desktop and 390px mobile were exercised; no horizontal document overflow. The
Communication tab had work-number controls and neither the credit panel nor saved
cards. Card loading/error retry, explicit default mutation and native purchase-control
exclusion are covered by component tests. Ownership tests include a foreign email-matched
purchase, foreign payment method/customer, conflicting subscription customer and a
canceled subscription. Security re-review found no remaining high/critical issues.

Validation in the follow-up worktree: 4 focused files / 33 tests passed, then 11 card
ownership tests passed after added canceled-subscription cases. Full unit run returned
9464 passed / 2 failed: existing listing-wizard attachment tests lack a valid subscription
coverage response and stop before upload assertions. This fixture gap is pending the
original review pipeline and must be resolved before final handoff. Final card-focused rerun passed 16 tests across 2 files, including the shared default-change pending guard. New-card ESLint
returned zero warnings/errors; TypeScript returned zero errors. Graph rebuild completed
with the existing missing Swift grammar warning; portable-check passed.
