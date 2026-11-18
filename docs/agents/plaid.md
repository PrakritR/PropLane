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
