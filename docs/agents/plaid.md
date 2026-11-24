# Plaid

Plaid links a bank login so PropLane can read it. All three values of
`plaid_items.purpose` are built: `bank_feed` (a manager's Financials > Bank rec),
`resident_pay` (§ Resident bank pay) and `income` (§ Income check). The first two
go through `authorizePlaidPurpose` (`src/lib/plaid/access.server.ts`) and must be
listed in `PLAID_ENABLED_PURPOSES`; `income` has its own gate
(`authorizeIncomeActor`, any signed-in applicant) and is deliberately NOT in that
list, so `/api/plaid/status?purpose=income` stays `enabled: false`.
**Stripe stays the money rail** — Plaid never moves money, and the owner/vendor
payout bank stays on Stripe Financial Connections.

Code: `src/lib/plaid/` (`client.server.ts`, `items.server.ts`, `exchange.server.ts`,
`link-routes.server.ts`, `transactions-sync.server.ts`, `statement-balances.server.ts`,
`resident-pay.server.ts`, `stripe-processor.server.ts`, `income.server.ts`,
`income-calc.ts`, `webhook-verify.server.ts`, `webhook-events.server.ts`), routes
`/api/plaid/{link-token,exchange,sync,status,webhook}`,
`/api/plaid/income/{link-token,verify}`, `/api/resident/plaid/{link-token,exchange}`,
`/api/screening/income`, `/api/stripe/resident-plaid-bank` and `/api/cron/plaid-sync`,
UI `plaid-link-button.tsx` + `pro-bank-reconciliation-panel.tsx` +
`resident-bank-account-form.tsx` + `application-income-verify.tsx`. Schema:
`20261118120000_plaid_items.sql`, `20261118130000_applicant_income_verifications.sql`,
`20261118140000_bank_statement_source.sql`,
`20261121120000_plaid_items_one_live_feed.sql`.

**One path, one purpose where the lock cares.** The managed read-only allowlist
(`MANAGED_READ_ONLY_ALLOWED_PATHS`) is a pure PATH policy, so the resident's own bank
pay gets its own routes under the allowlisted `/api/resident/plaid/*`, pinned to
`resident_pay` by `plaidLinkTokenRoute(req, { only })`. The generic `/api/plaid/*`
routes can reach a manager's `bank_feed` connect and stay refused for a locked client;
`/api/plaid/income` is allowlisted because it writes only rows keyed on the applicant's
own user id.

## Resident bank pay (`resident_pay`)

Resident Payments > pay with bank offers "Log in to your bank" (Link, products `auth`) before the typed
numbers (`resident-bank-account-form.tsx`, kind `payment`, in-app only). `POST /api/stripe/resident-plaid-bank`
runs the typed path's gate order (resident role via `authorizeResidentRole`, test-workspace gate, then Stripe),
proves the PaymentIntent's attempt is the session resident's, mints a Stripe bank token
(`stripe-processor.server.ts`), adds it to the resident's Customer as a verified `ba_` bank (reusing one with the
same fingerprint), and confirms the existing manual-ACH PaymentIntent with the one-time debit mandate (the body
must carry `authorized: true`). A `btok_` cannot go through SetupIntents, which is why it is a customer bank
account (Stripe lists it as a `us_bank_account` PaymentMethod under the same id). Because that bank stays on the
Customer — in the saved bank list, and selectable for autopay — the Plaid path's authorization says so: it covers
this debit AND saving the account for payments the resident approves, with autopay only if they separately enable
it. Never show one-time-only wording on a path that persists the bank. Needs the Stripe integration
enabled in the Plaid dashboard (Integrations > Stripe) or Plaid answers INVALID_PRODUCT. Typed numbers with
micro-deposits stay as "Enter numbers instead"; phone-bound links and saved-bank setup never show Plaid.

## Invariants

- **Disabled means hidden.** `plaidEnabled()` is false unless `PLAID_CLIENT_ID`, `PLAID_SECRET`
  and `PLAID_ENV` (`sandbox` | `production`) are all set. Routes 404 and `/api/plaid/status`
  answers `enabled: false`, so the client draws no Plaid control. Keys never reach the client.
- **The access token never leaves the server or a log.** Stored in `plaid_items.access_token_enc`
  (`encryptSensitiveValue`, purpose `plaid`, AAD = owner + row id + field). The table has no
  client grants. Log `plaidFailure(error).code` only: a raw axios error carries the secret header.
- **Only the mask is stored.** Institution, account name and the last four. Never an account or
  routing number.
- **The owner is the session user.** The link token and the exchange derive the user (and the
  Financials permission for `bank_feed`) from the session, never the body. Update mode (Reconnect)
  resolves the item by our row id scoped to that user.
- **The webhook is JWT-verified.** `verifyPlaidWebhook`: ES256 `Plaid-Verification`, key by `kid`
  from `/webhook_verification_key/get`, `iat` within 5 minutes, `request_body_sha256` equals the
  SHA-256 of the raw body. Anything else is a 401 that does nothing. URL: `PLAID_WEBHOOK_URL`, else
  the canonical origin on a production runtime; with neither, the daily cron covers it.
- **One live bank feed per bank account.** Plaid mints a FRESH `item_id` for every Link session, so the
  `item_id` dedupe cannot see a second "Connect bank" on an account that already has a feed — and two items
  post the same real transactions under their own transaction ids, doubling every line and every balance
  derived from the line sums. `createPlaidItem` refuses it (409, "already connected"; Reconnect runs in
  update mode and keeps the `item_id`), and the partial unique index
  `plaid_items_one_live_bank_feed_key` holds the same invariant for the double-click, so a race answers
  that refusal and never a 502. A `revoked` item is excluded: the account can be linked again.
- **A line is never dropped to keep a closed month closed.** `statementForMonth` opens ANOTHER feed-owned
  statement for a month whose every statement is already reconciled, because the cursor advances once a
  batch is applied and Plaid never re-delivers it — a late-posting item would be lost for good. The
  reconciled statement itself is never written.
- **A statement line is found through its own owner.** `loadExisting` inner-joins
  `manager_bank_statements` on `manager_user_id`, so the update and delete that name rows by id can only
  ever reach this owner's lines: a collided or replayed Plaid transaction id is simply not found.
- **Sync is idempotent and suggestion-only.** `/transactions/sync` by cursor; lines upsert on
  `manager_bank_statement_lines.plaid_transaction_id` into the open statement for that month.
  A modified transaction updates only a line nobody matched or cleared; a removed one deletes only
  an unmatched, uncleared line on an unreconciled statement. `added` counts rows the upsert really
  inserted, never the attempt. Matching stays the manager's (`suggest_bank_statement_matches`, then
  reconcile).
- **The feed only writes balances onto statements it created.** `manager_bank_statements.source` is
  the marker (`'plaid_feed'` when `statementForMonth` inserts the month, default `'manual'` for
  everything the manager typed or imported, including every pre-existing row).
  `fillFeedStatementBalances` walks back from the bank's current balance newest month first and stops
  at the first statement that is reconciled, not `'plaid_feed'`, or holds a line with no
  `plaid_transaction_id` — so a hand-made statement's typed opening / closing is never rewritten,
  even when it holds no lines at all. The line read is paged at PostgREST's 1000-row cap: a truncated
  read would under-count one month and, because each opening chains into the next closing, corrupt
  every older one.
- **A Plaid item's purpose is fixed for its life.** Re-exchanging the same `item_id` under another
  purpose, or under another owner, is refused with a `PlaidItemConflictError` carrying its own status
  (409 / 403) that `exchangePublicToken` turns into a typed refusal — never a bare throw that a route
  answers as "couldn't reach your bank". Its message reaches the requester, so the foreign-owner case
  stays generic ("This bank login can't be connected here."): that another account holds the login is
  not theirs to learn. A reconnect that names no bank account keeps the one the feed
  is already bound to.
- **Log through `logPlaidFailure`, and never log an error that touched the HTTP client.** An
  `AxiosError` keeps `config` / `request` / `response.config` as own enumerable properties and the
  Plaid client's config headers hold `PLAID-SECRET`, so `util.inspect` would print the live secret —
  and a transport failure (timeout, DNS, TLS, a 5xx with an HTML body) carries NO Plaid error body, so
  "is it Plaid-shaped" is the wrong question. `isTransportError` is the gate: anything that answers it
  is reduced to its public code plus the transport code, status and message. Only an error that never
  went through the client (Stripe, the database, a bug) is logged whole, which is what keeps it
  debuggable after `plaidFailure` would have flattened it to `UNREACHABLE`.
- **A Plaid item is owner-keyed, with no workspace of its own.** The token's AAD binds it to the owner, it
  points at `manager_bank_accounts` (itself `keep` on `manager_user_id` in the managed mover), and the
  mover classifies `plaid_items` the same way. There is deliberately no `workspace_id` column to scope a
  bank feed by (`20261121120000_plaid_items_one_live_feed.sql` drops the unused one).
- **Every Plaid route is rate limited.** Link token, exchange, the resident's bank pay and the manager's own
  Retry carry the same ceiling as the income routes (`plaid-link-token` / `plaid-exchange` /
  `plaid-resident-pay` 10, `plaid-sync` 20, per user + IP per ten minutes): each is an outbound Plaid call,
  and being signed in is not a budget.
- **One failing item is its own failure.** `syncPlaidItem` answers a claim it could not take as a result,
  never a throw, and `/api/cron/plaid-sync` guards each item — a single unreadable row never costs every
  connection behind it that day's transactions (the webhook is the only other trigger, and a deployment
  without `PLAID_WEBHOOK_URL` has none).
- **Purge.** `plaid_items` is in `account-purge-manifest.ts`; a purge calls `/item/remove`
  best-effort first, and a single-portal removal drops only that portal's purposes.

## Income check (`income`)

A per-listing setting, `verifyIncomeWithPlaid` in the `applicantScreening` namespace (default OFF; Settings > Automations >
Screening, "Verify income with Plaid"). It only OFFERS the check: skipping is always allowed, it never blocks a submit and a
group never waits on it.

- **Offer.** The Work and income step draws "Verify income" (Link bank | Skip and upload pay stubs) only when
  `GET /api/screening/income?propertyId=` answers `offered: true`: Plaid enabled, the listing's setting on, and a signed-in
  applicant. A guest (no session) never sees it and keeps the pay-stub path. Binding a guest to the held draft was judged too
  much: the held draft only exists after the form is finished, and the account is created after proof.
- **Method.** Link with the Transactions product (90 days), then `/transactions/get` and `income-calc.ts`: payroll-style
  deposits (Plaid `INCOME_WAGES`, or a payroll name; never a transfer, refund, peer payment or pending line) divided by the
  LONGER of the 3 months asked for and the period those deposits cover. `depositCoverageMonths` reads the cadence off the
  deposits: `n` of them spanning `span` days imply a cycle of `span / (n - 1)` and cover `span + cycle` days, floored at the
  3 months requested and never rounded. The figure is therefore **never biased upward**: deposits spread wider than the
  window divide by the period they really cover (three paychecks 45 days apart over the whole window are one paycheck every
  45 days, not one a month), and a bank that shared only a few weeks divides by the whole window rather than annualizing
  that slice up — a paycheck we cannot see can only understate. `INCOME_MIN_DEPOSITS` is **three**, because two
  deposits are one gap: a cadence guessed from a single interval cannot tell a monthly paycheck pair from a paycheck plus
  a bonus. Fewer than three, or a span under `INCOME_MIN_COVERAGE_DAYS` of real observation, and there is no figure at
  all — which costs the applicant nothing, since the check never blocks a submit. A refusal names WHICH of the two it is
  (`IncomeEstimateRefusal`: `no_payroll_deposits` vs `not_enough_history`) and `INCOME_REFUSAL_MESSAGE` maps it to the
  one message, so an applicant whose bank shared too little is never told no paychecks were found. Only
  `estimateMonthlyIncome` knows which applies — never re-derive it by counting deposits at the call site. `months` in the manager's line is the
  whole-month label for the history the bank SHARED (`observedMonths`), a fact they can hold the figure against; the
  figure itself comes from the unrounded divisor, which is derived, not observed, and never shorter than the window. Plaid's own Income products (`/credit/bank_income/get`) need separate product
  access, so they are not used; proven against the sandbox with a custom user.
- **Server-owned.** `POST /api/plaid/income/verify` takes only the public token and the listing id (never a figure), computes
  on the server, stores one row per (applicant, listing) in `applicant_income_verifications` (service role only, a figure and
  the institution, never a token) and removes the Plaid Item before returning: no access token lingers. The signed-in
  application write stamps `row.incomeVerification` from that row (fresh within 30 days) or the stored row, never from the body;
  the guest upsert keeps only what is already stored.
- **Manager.** One plain glyph fact, never a pill: `Income $4,800/mo stated · ✓ $4,850/mo verified (Plaid, 3 mo)`
  (`incomeStatedVsVerifiedLine`) in the review, the fact cards, the HTML and the PDF (the PDF omits the check mark: its standard
  font cannot draw it).
- **FCRA.** No decline or ranking logic is tied to this figure. TODO: counsel to review whether a bank-derived income figure
  shown to a manager is a consumer report before any decision uses it.
- Disabled Plaid hides the offer even with the setting on, AND hides the manager's own toggle: the settings route answers
  `plaidEnabled` and `ApplicantChecksSettingsRows` draws the row only when it is true, while `PATCH` refuses turning it on. Purge: `applicant_income_verifications` is classified in
  `account-purge-manifest.ts` (resident scope).
