# Plaid

Plaid links a bank login so PropLane can read it. Today one purpose is built:
`bank_feed` (a manager's Financials > Bank rec). `resident_pay` and `income` are
reserved values of `plaid_items.purpose`; adding one is a new entry in
`PLAID_ENABLED_PURPOSES` plus a branch in `authorizePlaidPurpose`
(`src/lib/plaid/access.server.ts`). **Stripe stays the money rail** — Plaid never
moves money, and the owner/vendor payout bank stays on Stripe Financial Connections.

Code: `src/lib/plaid/` (`client.server.ts`, `items.server.ts`, `exchange.server.ts`,
`transactions-sync.server.ts`, `webhook-verify.server.ts`, `webhook-events.server.ts`),
routes `/api/plaid/{link-token,exchange,sync,status,webhook}` and `/api/cron/plaid-sync`,
UI `plaid-link-button.tsx` + `pro-bank-reconciliation-panel.tsx`. Schema:
`20261118120000_plaid_items.sql`.

## Resident bank pay (`resident_pay`)

Resident Payments > pay with bank offers "Log in to your bank" (Link, products `auth`) before the typed
numbers (`resident-bank-account-form.tsx`, kind `payment`, in-app only). `POST /api/stripe/resident-plaid-bank`
runs the typed path's gate order (resident role via `authorizeResidentRole`, test-workspace gate, then Stripe),
proves the PaymentIntent's attempt is the session resident's, mints a Stripe bank token
(`stripe-processor.server.ts`), adds it to the resident's Customer as a verified `ba_` bank (reusing one with the
same fingerprint), and confirms the existing manual-ACH PaymentIntent with the one-time debit mandate (the body
must carry `authorized: true`). A `btok_` cannot go through SetupIntents, which is why it is a customer bank
account (Stripe lists it as a `us_bank_account` PaymentMethod under the same id). Needs the Stripe integration
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
- **Sync is idempotent and suggestion-only.** `/transactions/sync` by cursor; lines upsert on
  `manager_bank_statement_lines.plaid_transaction_id` into the open statement for that month.
  A modified transaction updates only a line nobody matched or cleared; a removed one deletes only
  an unmatched, uncleared line on an unreconciled statement. Matching stays the manager's
  (`suggest_bank_statement_matches`, then reconcile). A new month's statement starts at 0 / 0
  balances; the manager still enters them.
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
  deposits (Plaid `INCOME_WAGES`, or a payroll name; never a transfer, refund, peer payment or pending line) averaged over 3
  months, at least two deposits or no figure. Plaid's own Income products (`/credit/bank_income/get`) need separate product
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
- Disabled Plaid hides the offer even with the setting on. Purge: `applicant_income_verifications` is classified in
  `account-purge-manifest.ts` (resident scope).
