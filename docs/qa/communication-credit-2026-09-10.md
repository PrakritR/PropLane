# Communication credit, processing coverage and saved cards

Subscription prices remain Free / $20 / $200 monthly ($192 / $1,920 annual).
Monthly communication credit is $2 / $10 / $100. Every tier retains work-number
and Communication access. Processing fees are separate; only staff account approval
allows PropLane coverage. Manual credit packs are $5, $10, $25 and $50.

Billing & plan owns the plan, saved cards, credit balance, purchases, usage history
and budget alerts. Communication settings owns work-number setup. Stripe Checkout
setup mode saves cards without collecting payment. Default selection updates the
customer and active subscription; credit purchases remain separately confirmed.
Financial identity requires an authenticated user-ID link, never an email fallback.

## Current validation

- Combined keeper: 68 targeted tests across 4 files passed (exit 0), covering saved
  cards, credit purchases and listing submission. This includes all 18 card tests
  and all 27 listing-wizard tests. First-time customer creation, failed identity
  saves, foreign ownership, canceled subscriptions and concurrent default clicks
  are covered.
- Combined `npm run build`: exit 0, including TypeScript. New-card ESLint: exit 0,
  zero warnings/errors. Existing warnings remain in older listing/payment components.
- Initial full unit run: 1,369 files / 9,444 tests passed. A later full run found
  two listing upload-test fixture failures (9,464 passed); those fixtures now
  provide verified coverage and await loading, and their 27-test file passes.
  The broader no-mistakes validation is still running; this is not a final gate pass.
- PostgreSQL: 10 tests passed (exit 0), including concurrent reservations,
  idempotent fulfillment/refunds, UTC resets/upgrades, inherited allowances,
  atomic budget alerts and concurrent staff revocation versus preference saves.
- Security review and Bugbot found no remaining high/P1 issues in their spot-checks.
  The review's committed webhook, inbound identity, rate lookup, cache and fixture
  fixes have been merged into the keeper with their ancestry preserved.

## Real dev/test verification

The seeded manager's Business coverage resolves false. Its existing $150 current
allowance is preserved with a $100 next-month disclosure. Invalid credit packs return
400. Work-number and Communication settings remain accessible.

An actual Stripe **test-mode** $5 checkout completed. Replaying its signed event
twice yielded one $5 ledger adjustment. An actual $2 partial refund followed by two
signed deliveries yielded one -$2 adjustment, leaving $3 purchased credit.

The embedded Stripe setup form saved Visa 4242 (12/2030), returned to Billing & plan,
and the card was selected as default. Stripe confirmed `mode=setup`, a completed
session and no PaymentIntent. The API and Stripe customer default agreed. Purchased
credit remained $3. An uncompleted $5 credit checkout used the same customer; the
saved card has `allow_redisplay=always`.

Desktop and 390px mobile were exercised without horizontal document overflow. The
Communication tab contained work-number controls and neither saved cards nor the
credit panel. Browser console error collection was empty. No real SMS was sent,
no phone number was purchased and no live call was placed.

## Rollout and outstanding decisions

Only dev/test migrations were applied: `20260910140000`, `20260910160000`, and
`20260910170000`. Root and remote migration histories differed, so a temporary
Supabase workdir used the fetched remote history; dry-run listed only the new
migrations. No history was repaired or overwritten. Follow the staging ladder
before enabling manual checkout with `COMMS_PAYG_BILLING_ENABLED=1`; that flag
cannot disable credit enforcement.

The existing Lavish review contains the full policy findings and proposed states.
The user has been asked about staff recovery for reviewed credit pauses, disabling
the retired relay's provisioning/number-buying, and visibility for paid purchases
needing manual review. The proposed resolution retains fail-closed fee verification
and reconciliation holds for uncertain SMS outcomes, and leaves unrelated account
retention code unchanged. Those policy decisions are pending; no keeper push or
production deployment has occurred.

Native balances are shared, but Apple consumables/RevenueCat credit fulfillment are
not configured. Native hides Stripe checkout, card setup/default controls and external
purchase links. See `docs/agents/apple-iap.md`. The successful standard build uses
Turbopack; the isolated checkout needed a local dependency copy rather than a symlink.
Graph refreshes passed with the existing missing Swift-grammar warning, and portable
checks passed. The installed hook did not create a TypeScript runtime marker.
