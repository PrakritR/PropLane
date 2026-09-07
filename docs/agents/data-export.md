# Manager data export (PRP-324)

A manager can take everything their property account owns out of PropLane as ONE
encrypted, password-protected file — Settings → Account → **Export my data**. Read this
before touching `src/lib/account-export/` or `POST /api/portal/data-export`.

## Shape

- **Route:** `POST /api/portal/data-export` with `{ password }` (12–256 chars). Answers the
  file as `Content-Disposition: attachment`, `nosniff`, `Cache-Control: private, no-store`,
  named `proplane-export-<yyyy-mm-dd>.proplane`. 401 without a session, 403 for an account
  with no manager role, 400 for a short password, 429 after one export in ten minutes (per
  user, via `rateLimit`), 503 when the shared limiter is unreachable.
- **What is inside:** a zip — `manifest.json` (export date, manager id, schema version,
  per-table row counts, the exclusion patterns) plus `tables/<table>.json` (an array of
  rows) — sealed with AES-256-GCM under an scrypt-derived key
  (`src/lib/account-export/export-crypto.ts` documents the byte layout). PropLane never
  stores the password; a wrong one is a GCM authentication failure, not garbage.
- **Client:** `PortalDataExportButton` (`portal-data-export-button.tsx`), rendered by
  `PortalSettingsExtras` for `manager` / `pro` only, next to Delete account. It posts the
  password, then hands the bytes to `downloadOrShareFile` so the Capacitor shell gets the
  share sheet (WKWebView ignores a synthetic `<a download>`).
- **Analytics:** `data_export_completed` (server, `{ tableCount, rowCount }`) next to the
  success return.

## The two invariants

1. **Tables come from the purge manifest, never a second list.** `managerExportTables()`
   takes every `ACCOUNT_PURGE_TABLES` entry whose `manager` rule has `ids` or `emails`
   — exactly the rows a delete would remove. `detachIds` / `detachEmails`-only tables are
   other people's records that merely point at this account and are NOT exported.
   `tests/unit/account-purge-coverage.test.ts` already fails on an unclassified table, so a
   new table reaches the export by being classified for deletion. Every select is pinned
   to the session's `user.id` / account email on the service-role client (the same
   pattern as `PATCH /api/profile`); the body never names a row.
2. **PII is stripped by key pattern, recursively.** `EXPORT_EXCLUDED_KEY_PATTERNS`
   (`pii-exclusion.ts`) is applied to column names AND to every key inside `row_data` —
   the application's SSN lives at `row_data.application.ssn` and the encrypted identity
   envelope at `row_data._applicantIdentity.ciphertext`, so a column-only filter would
   export both. Any string value that is an encrypted envelope (`proplane:` prefix) is
   dropped wherever it sits. Add a pattern when a new sensitive key appears; never add a
   per-table allowance. Coverage: `tests/unit/account-export-pii-exclusion.test.ts`.

## Opening a file

```
PROPLANE_EXPORT_PASSWORD='…' node scripts/open-proplane-export.mjs proplane-export-2026-09-07.proplane --extract ./export
```

`scripts/open-proplane-export.mjs` is dependency-free Node: it writes the decrypted zip
beside the input (`--out` to choose) and, with `--extract`, unpacks `manifest.json` and
`tables/*.json`. It mirrors the container layout in `export-crypto.ts` byte for byte, so a
version bump there needs a matching branch in the script. Without the env var it prompts on
the terminal; the password is never a CLI flag.

Coverage: `tests/unit/account-export-crypto.test.ts` (round-trip, wrong password,
tampering), `tests/unit/data-export-route.test.ts` (401 / 400 / 403 / 429 and the
attachment headers).
