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

- Merged current `prakrit` into the keeper, preserving its newer listing layout and
  staff-only processing coverage. The work-email integration regression is fixed:
  verified email access no longer depends on prepaid SMS/call credit.
- Full merged test run: **1,430 files / 9,822 tests passed**, 3 files / 30 tests
  skipped (exit 0). Stripe subscription integration fixtures now exercise the
  strict user-ID-linked customer path; all 8 pass. Listing assertions match the
  approved staff-coverage behavior.
- Merged production build and TypeScript: exit 0. Changed-file ESLint: exit 0;
  pre-existing hook warnings remain. Mobile balance layout was visually corrected
  and rechecked at 390px; exhausted-credit guidance points to Billing & plan.
- PostgreSQL: 10 tests passed (exit 0), including concurrent reservations,
  idempotent fulfillment/refunds, UTC resets/upgrades, inherited allowances,
  atomic budget alerts and concurrent staff revocation versus preference saves.
- Security and Bugbot integration reviews found no High/Critical/P1 issues.
  Their work-email P2 is fixed. All no-mistakes webhook, inbound identity, rate,
  cache, mock and voice-bound test commits are preserved in keeper ancestry.
  The automated gate is still running; this is not a final gate-pass claim.
- Prakrit selected **localhost:3006** for this workspace and future changes.
  `.env.local`, the local agent rule and Firstmate lane port are pinned to 3006.
  Review: http://localhost:3006/portal/profile?tab=billing.

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
