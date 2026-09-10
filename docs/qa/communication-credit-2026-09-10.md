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
