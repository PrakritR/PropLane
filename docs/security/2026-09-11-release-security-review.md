# Release security review - 2026-09-11

## Scope and evidence

- Review base: `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- Checked HEAD: `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`.
- The current index has an uncommitted merge with `MERGE_HEAD`
  `8ce3868b4e5775661956c6c3f36fcb146bfa931a` (`main`). Findings apply to
  the current working tree and index, not just HEAD.
- Reviewed the current-tree diff from the base, with emphasis on billing
  authorization/RLS/grants, Stripe identity and idempotence, tour/SMS consent,
  and the owner SMS dispatcher merge.
- Excluded without inspection: `scripts/apply-20260911-comms-billing-migrations.mjs`
  and `tests/unit/comms-billing-migration-apply.test.ts`.
- No credentials were read, no network/database operation was made, and no
  application source or git state was changed.

## Files reviewed

- Canonical migrations:
  `20260910140000_manager_communication_credits.sql`,
  `20260910160000_comms_credit_alerts.sql`,
  `20260910170000_manager_billing_customer.sql`,
  `20260910180000_comms_wallet_snapshots.sql`, and
  `20260910190000_sms_outbox_campaign_budget.sql`.
- Billing and Stripe paths: `src/lib/comms-billing/{wallet,credit-purchase,record-usage,turn-result,voice-credit,summary}.server.ts`,
  `src/lib/manager-stripe-customer.server.ts`,
  `src/app/api/manager/{comms-billing/checkout,payment-methods}/route.ts`,
  `src/app/api/stripe/{checkout-portal,billing-portal,webhook}/route.ts`.
- SMS and tour paths: `src/lib/sms/{owner-sms-dispatcher,tour-sms-eligibility,vendor-conversation-consent}.server.ts`,
  `src/lib/{sms-relay,tour-notification-delivery,tour-inquiry-confirm,tour-reschedule-sms-reply}.server.ts`,
  `src/lib/tools/domains/tours.ts`,
  `src/lib/agent/{leasing-sms-agent,vendor-agent}.server.ts`, and
  `src/app/api/webhooks/twilio/sms/route.ts`.
- Related focused tests, including communication-credit purchase, PostgreSQL
  credit/campaign-budget integration, tour guest consent, vendor consent, and
  manager/co-manager SMS regression tests.

## Findings

### High - final SMS dispatch drops recipient-specific STOP protection

`src/lib/sms/owner-sms-dispatcher.server.ts:483-498` reconstructs the final
send policy from an outbox row but omits `recipientUserId: row.recipient_user_id`.
The policy then calls `readSmsSuppressionState` at lines 148-150, and the actual
carrier call at line 625 intentionally uses `skipOptOutCheck: true` because this
policy check is meant to be the enforcement boundary.

Exploitation scenario: queue a valid message for a recipient, then have that
recipient record STOP on their profile while their profile phone is blank or has
changed. The user-keyed profile row is only included when `recipientUserId` is
passed to `readSmsSuppressionState` (`src/lib/sms-consent.ts:104-113`). At the
outbox boundary it is not passed, so the dispatcher can miss that STOP and send
the already-queued message. This defeats the documented final send-time
suppression guarantee and creates SMS compliance risk.

Required correction: pass `recipientUserId: row.recipient_user_id` in the
`loadSendPolicy` call in the dispatch loop, and add a regression that queues a
row with a recipient user id whose profile has an unmatchable phone plus a
user-keyed opt-out. The test must assert `sendSms` is not called.

### High - subscription checkout has no request or durable session idempotency

`src/app/api/stripe/checkout-portal/route.ts:35-177` creates a new subscription
Checkout Session for every authenticated POST. Unlike the credit and card-setup
routes, it accepts no operation id, supplies no Stripe idempotency key, and does
not persist or reuse a pending session. The newly introduced customer reuse at
lines 124-136 makes all duplicate sessions charge the same manager customer.

Exploitation scenario: a double-click, retry after a lost response, or scripted
parallel POST creates two sessions. If both are completed, Stripe can create two
subscriptions for the same customer. The webhook reconciles a single local
purchase record but does not cancel the additional Stripe subscription, so the
manager can be billed twice while the portal represents only one entitlement.

Required correction: require a server-validated UUID operation id, persist the
pending subscription checkout keyed by manager and operation, and use that key
as Stripe's idempotency key. Reuse an unexpired open session and reject or
reconcile a second active subscription before issuing another checkout.

### Medium - subscription checkout does not enforce the manager route guard

`src/app/api/stripe/checkout-portal/route.ts:35-43` requires only an authenticated
user. It does not use `requireManagerRouteUser`, unlike the new communication
credit and payment-method paths. It subsequently creates a manager billing
customer using a service-role client at lines 124-127 and stamps a manager
subscription purchase with the caller's user id.

Exploitation scenario: a non-manager authenticated account can invoke this
endpoint and create a manager-billing Stripe customer and subscription flow for
itself. Even if it does not gain a portal role, this violates the stated manager
financial-identity boundary and can create orphaned billing state that staff
must reconcile.

Required correction: use the canonical manager route guard before loading the
profile or creating a billing customer, and add a resident/vendor denial test.

## Positive controls observed

- The reviewed credit tables enable RLS, revoke `anon` and `authenticated`
  access, and grant the new security-definer RPCs only to `service_role`.
- Credit fulfillment checks the paid session's purpose, mode, currency, exact
  amount, undiscounted total, owner reference, purchase id, and payment intent
  before invoking the atomic fulfillment RPC. Purchase and provider event keys
  provide database-side duplicate protection.
- Tour lifecycle SMS uses scoped consent plus a second dispatch-boundary
  validation for grants derived from a conversation. Vendor conversation grants
  check global suppression and preserve explicit revocation.
- The pending owner-dispatcher merge uses an outbox-bound campaign-budget RPC
  that verifies the worker claim and is service-role-only.

## Verification and limitations

This was a static, bounded security review. I inspected source, canonical
migrations, current index/working-tree state, and focused test coverage. I did
not run tests, build, lint, browser flows, Stripe/Twilio calls, database queries,
or migrations. The two explicitly excluded untracked files were not read. The
absence of additional findings is not evidence that those unexecuted paths are
safe. Both High findings should be resolved and regression-tested before this
production release proceeds.
