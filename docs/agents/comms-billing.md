# Manager communication credit

**A work number is a paid feature (round 3 plan model, Sep 2026).** Free has no work
number and no communication credit; Pro includes one number; Business includes one per
workspace. A signup or Stripe trial is not yet paying and cannot provision a number
(`reconcileManagerSmsEntitlement` refuses `trialing` on the number path); a FREE100 /
admin comp grant counts as paid. Provisioning, phone verification, carrier registration,
consent and runtime rollout controls still apply. The phone itself has no setup or monthly
usage deduction. Work email uses the same verified plan entitlement and remains unmetered;
an empty communication wallet never disables its address or setup.

| Plan | Subscription | Work number | Monthly retail communication credit |
| --- | --- | --- | --- |
| Free | $0 | none | $0 |
| Pro | $20/month or $192/year | 1 | $10 |
| Business | $200/month or $1,920/year | 1 per workspace | $100 |

Numbers held by Free accounts from the earlier every-plan policy are released once per
environment after the deploy: `POST /api/admin/release-free-work-numbers` (admin-gated;
`{ "dryRun": false }` to release, default is a dry run that lists them).

## Add-ons

Past the bundle a paying account adds units from Settings → Billing & plan
(`src/lib/plan-addons.ts`, quantities in `manager_plan_addons`, route
`/api/manager/plan-addons`). Each quota reads its plan cap PLUS the add-on quantity
(`manager-property-quota.server.ts`, `workspaces/server.ts`, `/api/pro/account-links`).

The Billing storefront sells only **Extra workspace** and **Extra residents**.
Communication credit is bought under **Extra usage** (typed dollar amount, Embedded
Checkout) — not as a monthly add-on. `extra_comms_credit`, `extra_work_number`, and
`extra_seat` remain in the catalogue for grandfathered rows but refuse writes
(`setManagerPlanAddonQuantities`). `extra_resident` is allowed in the DB check
constraint (`20260923200000_manager_plan_addons_extra_resident`).

| Add-on (storefront) | Pro | Business |
| --- | --- | --- |
| Extra workspace | $15/mo | $30/mo |
| Extra residents | $3/mo | $2/mo |

| Retired (not sold) | Notes |
| --- | --- |
| Communication credits | Use Extra usage |
| Extra work number | One number per workspace |
| Extra co-manager seat | Seats uncapped |
| Extra property listing | Per-door billing |

**Add-ons are always purchasable (PLAN-0920).** A row is never disabled for a missing
Stripe Price: `ensureAddonPrice()` (`plan-addons.server.ts`) resolves it in order — the
env override `STRIPE_PRICE_ADDON_<EXTRA_WORKSPACE|EXTRA_RESIDENT>_<PRO|BUSINESS>`,
then an existing Price under the add-on's stable `lookup_key`
(`planAddonLookupKey`, `proplane_addon_<id>_<tier>`), then creates the Product + Price
from the catalog — idempotent across processes and cached per process. Comp and admin
grants record quantities without Stripe (`getManagerPurchaseSku` has no billable
subscription, so nothing is sent to Stripe at all).

The panel's steppers change only local draft state; nothing is sent until the manager
presses **Buy**, which applies every changed row as ONE Stripe subscription update
(`setManagerPlanAddonQuantities`, `PATCH /api/manager/plan-addons` with
`{ changes: [{ addonId, quantity }] }`) — all-or-nothing and prorated. On any Stripe
failure nothing is written and the caller's existing quantities are returned unchanged;
on success the panel re-reads quantities from the response, never from the click. The
older single-item `{ addonId, quantity }` body still works on both `PATCH` and `POST`
for backward compatibility. Caps: `extra_work_number` total is capped at 2 per workspace
(`maxExtraWorkNumberQuantity`, `includedWorkNumbers` + purchased `extra_workspace`
together set the workspace count); `extra_workspace` is capped by the product limit on
Pro and by `WORKSPACE_LIMIT` on Business (`maxExtraWorkspaceQuantity`).

## The wallet is per workspace, not per account

Credit lives in `manager_comms_workspace_wallets`, keyed `(manager_user_id, workspace_id)`.
`manager_comms_billing_accounts` keeps the Stripe customer, the pause and the alert
state — one row per owner — and its balance columns are zeroed and unused. Every
purchase and usage event carries `workspace_id`, so the wallet that paid for a text is
the wallet that gets the refund when it is released or settled short.

**The included monthly allowance belongs to the owner's default workspace alone.**
Every other workspace starts each period at $0 included and spends only purchased
credit. Otherwise buying a second workspace would silently multiply the plan's
included credit. `comms_wallet_snapshot(p_owner, p_workspace, …)` is the one place that
decision lives.

The sending workspace comes from the work number: `manager_sms_numbers.workspace_id`
for the line the message goes out on (`comms_send_workspace_for_number` in SQL,
`loadSendPolicy` in `owner-sms-dispatcher.server.ts`). A co-manager messaging from a
workspace spends that workspace's wallet; only its **owner** may buy credit for it, and
the checkout route re-derives ownership from `portal_workspaces.owner_user_id` rather
than trusting the body. `finish_comms_credit` and `settle_comms_credit_quantity` take
no workspace argument on purpose — they read it off the usage event, so a refund can
never land in a different wallet than the one debited.

Annual subscriptions receive the same monthly credit. Credit resets on the first of
each month at 00:00 UTC. The one-month migration grace that let an existing manager
keep a higher legacy allowance has ended (PLAN-0920-1400): `wallet.server.ts`'s
`legacyAllowanceCentsForTier` now equals the plan's own `includedAllowanceCents`, so
`greatest(allowance, legacy)` in `comms_wallet_snapshot` is a no-op and the plan's own
allowance always applies — a Business account reads exactly $100.00. An upgrade adds
only the positive allowance difference once; downgrades take effect at the next reset.

The paid allowance is 50% of monthly subscription price in **retail usage credit**,
not provider cost. Rates include operational overhead; provider and carrier costs can
vary. Pro's $10 buys at most 333 outbound single-segment texts and Business 3,333 if
used only for that meter; Free spends only purchased packs. Incoming messages, voice and AI share the same balance.

## Purchases and stops

Credit is bought from **Settings → Billing & plan → Extra usage**: a typed whole-dollar
amount from **$5 to $500** (default $20) for **one chosen workspace**, not a fixed pack — `isValidCommsCreditAmountCents`
in `credit-packs.ts` is the one bound the checkout route, `credit-purchase.server.ts`, and
the webhook fulfillment all enforce. Purchased credit carries forward without expiry and
is spent after included credit. A saved card never authorizes automatic recharge or
overage. Insufficient credit blocks new outgoing SMS, calls and work-number AI. Incoming
SMS is stored first and uses available credit only; unavoidable excess is absorbed by
PropLane. Message history and the assigned number remain available.

`COMMS_PAYG_BILLING_ENABLED=1` now enables **manual credit checkout only**. It defaults
off until the migrations and signed Stripe webhook are available. The former
`COMMS_LIMITS_ENFORCED` flag cannot disable credit enforcement. The old invoicing cron
and invoicing helper return a retired/no-op response; they never invoice usage.

Web checkout uses Stripe. The native app shares balances and communication, but does
not show Stripe checkout or an external purchase link. Apple consumable products and
RevenueCat fulfillment need separate setup before native top-ups can be offered; see
`apple-iap.md`. This does not restrict credit already bought on the web.

## Billing & plan and saved cards

Settings → Billing & plan owns the current plan, payment methods, communication
balance, Buy credit checkout, usage, and Alert at. Promo codes belong on checkout
(and signup), not on that page. Communication settings owns work-number setup:
a free trial must Activate paid plan first; FREE100 / waiver counts as paid.

`/api/manager/payment-methods` lists masked cards, opens Stripe Checkout in `setup`
mode, and sets an explicitly selected default. Setup collects no payment. Stripe
attaches the card to the manager's customer; the app never handles card numbers or
CVC. Default selection updates both the customer and any active linked subscription;
it does not retry invoices or recharge credit. Canceled subscriptions are not updated.

`loadManagerBillingIdentity` is the financial identity boundary. It reads only
`manager_purchases.user_id = authenticated manager id` and the owner's billing
account. **Never use the entitlement loader's email fallback for financial credentials.**
Resolve the subscription's customer first and reject conflicting identities before
any card exposure or mutation. A new Free customer is created only on explicit setup
or checkout, then persisted in `manager_comms_billing_accounts.stripe_customer_id`.
Subscription checkout, manual top-ups and the billing portal share this identity.

Apply `20260910170000_manager_billing_customer.sql` before enabling card management.
The existing service-role-only billing table retains its permissions. Native shows
masked cards but hides Stripe setup/default controls; App Store billing stays with Apple.

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

Apply `20260910140000_manager_communication_credits.sql`,
`20260910160000_comms_credit_alerts.sql` and `20260910180000_comms_wallet_snapshots.sql`
after the original billing migration. New wallet/purchase RPCs and tables are
service-role-only. Canonical `getEffectiveManagerSkuTier` supplies every quota;
unreadable plans fail closed.

The admin Billing list reads communication credit from `comms_wallet_snapshots`
(`loadCommsWalletTotals`): one read-only round trip that runs the canonical snapshot
per owner with `p_apply=false`, so staff see the same plan allowance and unspent
purchased credit exactly as the dispatcher does. Never derive a staff balance from
the plan table plus usage. An owner whose wallet cannot be computed shows "comms —".

- `GET /api/manager/comms-billing`: read-only balance, usage, rates and recent purchases.
- `PATCH /api/manager/comms-billing`: `{ monthlyBudgetCents }`, alert only. Cannot clear a pause.
- `POST /api/manager/comms-billing/checkout`: server-validated whole-dollar amount
  ($5–$500) and UUID operation id; owner derives from authenticated manager context.
  Co-manager access grants no spending authority.
- `GET /api/manager/usage-summary`: read-only communication, listing, workspace, work-number
  and co-manager usage for Settings → Billing & plan's Usage section (one summary read,
  `resolveEffectiveManagerSkuTier` drives every cap).
- `GET /api/manager/invoices`: read-only Stripe invoices plus credit-purchase receipts for
  the Invoices table; every hosted URL is server-minted, never client-constructed.
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

The legacy `/api/webhooks/twilio/sms` route resolves the owner of the texted number
(`resolveOwnedWorkNumber`) before any session lookup, meters the inbound segment to that
owner, and drops texts to shared or unmanaged destinations so no unrelated wallet is
charged. Relay legs (`sms-relay.server.ts`) carry no reservation and are refused by the
transport; each refusal is logged by thread and leg only.

Model-turn completion is persisted against the reservation before delivery, merged into
the reservation's own metadata so session provenance survives. Replays
reuse it. A turn interrupted for more than ten minutes produces an explicit terminal
notice instead of repeating tools; the manager must inspect existing portal actions.
Unknown carrier submissions retain their debit and enter operator reconciliation,
never automatic resend. Confirm provider outcome before releasing any such reservation.
When the wallet itself cannot be read at dispatch (`credit_unavailable`), the outbox row
is deferred five minutes rather than blocked; only a definitive wallet answer
(`allowance_exhausted`, `billing_paused`, duplicate key) blocks terminally.

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
