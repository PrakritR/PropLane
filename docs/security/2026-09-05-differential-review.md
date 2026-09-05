# Security hardening differential review — 2026-09-05

## Executive summary

Baseline: `f44f23a4`, compared with uncommitted hardening changes. This is an agent-run review using the installed Trail of Bits differential-review methodology (including methodology/adversarial/reporting references) and insecure-defaults weak-crypto/fail-open corpus. It is **not an audit performed by Trail of Bits or an automated insecure-defaults workflow run**.

**Final recommendation: CONDITIONAL APPROVAL of the reviewed code.** The initial review found one High regression (DR-01); the implementing agent fixed it and the fix was re-reviewed. No open Critical/High code blocker remains in this bounded review. Deployment prerequisites and staging QA remain mandatory. Detailed fix disposition and additional script validation appear below.

Existing applicant JSON, document-byte encryption, other browser mirrors, trace minimization and TIN rotation gaps remain in `2026-09-05-data-security-review.md`. This patch does not establish all-data protection against a logical database/storage export.

## Changes reviewed and methodology

Risk-first surgical review of a large repository: inspected new crypto/RPC/header helpers, changed sensitive boundaries, related callers and tests. Changes include dependency updates, 44 API files adopting an async limiter, service-role-only SQL, versioned calendar-token encryption, browser-cache minimization, headers, Postgres TLS, TIN ciphertext validation, disclosure HTML sanitization and workflow input handling.

Non-webhook API diffs were mechanically verified as awaited rate-limit call changes only: no edits to authorization, ownership filters or write-confirmation logic. The lockfile was inspected as generated dependency updates; third-party package sources were not independently audited. No customer records, credentials, live production writes or outbound messages were used.

## DR-01 — High: store failure acknowledged as successfully dropped webhook traffic

Initial `src/lib/rate-limit.ts:35–38` converted RPC timeout, missing credentials/migration and malformed replies into the same `{ok:false}` as proven exhaustion. Six webhook checks then deliberately acknowledged over-limit traffic with HTTP 200 before durable ingest: three in `src/app/api/twilio/inbound/route.ts`, one in `src/app/api/webhooks/twilio/sms/route.ts`, two in `src/app/api/webhooks/email/inbound/route.ts`.

**Attacker/fault model:** an external sender placing load on limited routes, or an ordinary transient database/network fault. Authentic provider messages arriving during the outage are victims; no webhook-signature bypass is needed.

**Concrete sequence:** shared RPC fails → valid provider callback reaches limiter → `{ok:false}` → route returns 200 without storing message/receipt → provider considers delivery complete and does not retry. This newly violates durable-delivery/retry invariants and silently loses SMS/email.

**Required fix:** distinguish unavailable infrastructure from exhausted capacity. Both deny protected work, but unavailable webhook checks must return retryable 503; genuine exhaustion can retain intentional 200 shedding. Add webhook failure-versus-exhaustion tests. Sent to implementing agent immediately; no production outage was induced.

## Sensitive boundaries and attacker scenarios

### Calendar encryption

A database-export attacker lacking application secrets previously received readable credentials. `src/lib/security/data-encryption.ts` now uses AES-256-GCM, random 12-byte nonces, explicit 16-byte tags, canonical base64, version/key IDs and validated 32-byte keys. AAD binds version/key/purpose/owner/record/field, so valid ciphertext substituted between managers or token slots is rejected. Unknown `proplane:` versions are treated as encrypted and fail closed instead of becoming legacy plaintext tokens.

`src/lib/google-calendar/settings.ts` opens both column/fallback read paths and seals both write paths. Public projections omit tokens. Disconnect bypasses decryption only while erasing both credentials and connection state, providing recovery without disclosure. Caller authorization remains essential and unchanged.

Plaintext reads are temporary migration compatibility; new writes require encryption. Enable `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS=true` only after both storage locations are migrated, including stale fallback copies where the dedicated column is used. Old backups retain their original protection. The code accepts secret-store configuration; it does not provision KMS or prove production key access is restricted.

### Shared limiter SQL

An unauthenticated RPC caller must not consume another user's capacity. The table uses RLS, revoked public/anon/authenticated access and service_role grants. The function is security-invoker with empty search_path, qualified table names and service-role-only execute permission. HMAC keys omit raw IP/email/phone identifiers and include policy parameters.

The atomic INSERT/ON CONFLICT predicate serializes bucket updates, increments only below limit or after expiry and does not overflow saturated counters. Production/preview uses shared state and does not fall back to local memory. The existing proxy/IP trust predicate is unchanged and depends on trusted forwarding-header replacement. Rate limiting is not authentication or upstream denial-of-service protection.

### Browser cache

The old cache persisted original full co-signer SSNs despite server masking. The patch purges the legacy key, never hydrates it, keeps the new cache memory-only and masks SSN before insertion. HTTP errors cannot override 401/403 with cached rows. Production consumers use authorized fetches; synchronous cache consumers are demo-gated. The actual submission still contains the form transiently. Other applicant/browser stores remain outside this fix.

### Postgres TLS

Both runtime and CLI replace `rejectUnauthorized:false` with certificate verification, reject TLS disabling and reject connection-string SSL overrides that can replace explicit TLS options. Optional trusted CA input preserves verification. Deployments using `?sslmode=require` must remove it and configure trust first. Do not restore no-verify to resolve certificate failures. No real TLS handshake or certificate configuration was independently verified by this reviewer.

### TIN, HTML and workflow

TIN decryption now rejects noncanonical/truncated data and fixes tag length at 16 bytes, preserving the old ciphertext layout/derivation. This is not migration to the new calendar keyring.

Disclosure fragments reach `dangerouslySetInnerHTML` in the portal; extraction now uses the existing lease sanitizer first. Tests reject script/event handlers/unsafe URL/iframe input. This strengthens the raw path; it is not exhaustive parser fuzzing or a guarantee against every CSS/UI deception pattern.

Workflow `source` now flows through an environment variable and quoted argument instead of being inserted into shell source. The called script does not eval the value. The existing integration ladder is unchanged.

## Quantitative blast radius

Counts are rg source references/call sites, not a complete graph-reachability claim.

| Boundary | Observed reach |
| --- | --- |
| rateLimit | 55 calls across 44 API files, all awaited |
| Webhook limiter | 6 checks across 3 files |
| Calendar load/save | 18 calls plus 2 definitions, 10 referencing source files |
| New encryption helpers | 3 calendar calls plus 2 definitions |
| TIN encrypt/decrypt | 6 calls in 4 API files |
| Postgres helpers | Admin schema route and SQL-apply CLI |
| Disclosure extraction | 2 callers: same-module review and portal notice |
| Browser headers | Global Next response match |

## Validation

Reviewer executed:

```
npx vitest run tests/unit/security tests/unit/rate-limit.test.ts tests/unit/reports/tin-crypto.test.ts tests/unit/google-calendar-settings.test.ts tests/unit/platform-parity.test.ts
11 test files passed; 104 tests passed.
```

Coverage: crypto roundtrip/nonces, owner/record/purpose/field binding, nonce/tag/ciphertext tampering, key rotation/missing keys; both calendar storage modes, safe projections, strict reads and corrupted-data disconnect; limiter key privacy/policy separation/fail-closed behavior; cache deletion/denied fetches; TLS downgrade rejection; disclosure sanitization; native parity.

Initial limiter tests mock RPC; they do not prove live grants or concurrency. Initial tests missed DR-01. Live migrations/grants, final response headers, TLS handshakes, actual keys, backfill counts and browser/WebView preview behavior require separate evidence.

## Cache, rendering, performance and native compatibility

The static CSP adds base-uri/frame-ancestors/object-src without nonces or dynamic rendering, preserving caching. It intentionally lacks strict script-src/default-src: do not call it complete XSS protection. Same-origin framing, blob/Supabase PDF objects and camera(self) match known previews/uploads. The attachment route retains its stricter sandbox CSP in source; verify the final HTTP policy after applying global headers.

Native uses the same deployed app; parity tests pass, with no navigation/deep-link/native permission changes. Actual web/iOS/Android preview/upload smoke testing remains necessary; parity tests do not establish browser enforcement.

Each deployed limiter check adds a DB RPC with a three-second timeout; dual checks may spend six seconds sequentially. Monitor DB latency/egress and the non-PII shared_rate_limit_unavailable signal. Bounded expired-bucket cleanup only runs for hashes beginning 00, so a small stable population may never trigger cleanup; provide an operational cleanup fallback if counts grow.

## Historical evidence

- Memory limiter: blame `f60b5ae5e`; shared-store dependency creates DR-01.
- Postgres no-verify: `1f513b590`; removal strengthens validation.
- Raw disclosure extraction: `35acafa5b`; sanitizer is added.
- Workflow direct interpolation: `9982c9ab9`; env avoids shell-source interpretation.
- TIN missing-key refusal: `eef42b21c`; preserved.

## Release prerequisites

Resolve DR-01 with regression coverage; apply limiter migration before code; configure keys before credential writes; verify Postgres CA/URL configuration; backfill/audit both calendar storage locations without printing tokens; then enforce encrypted reads. Dedicated staging QA precedes production promotion. No all-data-encryption or Trail of Bits certification claim is justified by this review.


## Final re-review: DR-01 resolved

The limiter now returns `{ok:false, unavailable:true}` for store/configuration failure. All six webhook checks inspect `unavailable` first and return HTTP 503; only proven capacity exhaustion takes the intentional 200-shedding path. The managed SMS replay path still skips a new limit check for an existing receipt. These changes resolve the identified regression without failing open.

Re-run after the fix:

```
npx vitest run tests/unit/security tests/unit/twilio-inbound-retry.test.ts tests/unit/twilio-inbound-control.test.ts tests/unit/rate-limit.test.ts tests/unit/reports/tin-crypto.test.ts tests/unit/google-calendar-settings.test.ts tests/unit/platform-parity.test.ts
15 test files passed; 124 tests passed.
```

This includes three manager/legacy/unknown-number SMS outage paths, matching exhaustion cases, vendor SMS 503-versus-200 behavior and existing SMS retry/control tests. Email's global/per-sender unavailable guards were manually reviewed; an email-specific regression test was recommended separately.

## Backfill script review

Reviewed `scripts/security/calendar-backfill.ts`, `scripts/security/backfill-calendar-tokens.ts` and their helper tests. The command defaults to a read-only dry run, restricts `--apply` to dev/staging and requires the actual direct/pooler endpoint to match the declared project. Production apply is denied. No dynamic SQL identifiers originate from operator/customer input: selected column names are fixed, detected against information_schema, and values are parameterized. Both dedicated and fallback token copies are processed, including disconnected/orphaned tokens, while unrelated metadata is preserved. Current-key ciphertext is authenticated rather than blindly skipped. Old-key ciphertext rotates; malformed data aborts instead of being passed through.

Apply reads under `FOR UPDATE` and writes in one transaction with statement/lock timeouts; failures roll back. Output is aggregate counts only, and errors omit provider/credential details. The npm command uses `tsx --conditions=react-server`, correctly handling the crypto helper's server-only import. Operators still must provide matching keys, actual verified TLS and explicit target configuration; no hosted run was performed by this reviewer.

The whole-table transaction is appropriate to a small settings table; observe row counts before applying and plan batching if it grows. Row locks protect selected rows during migration, not arbitrary external writers that later restore stale whole-row snapshots. Deploy all encrypting writers before backfill/strict-read enforcement, and audit again afterward.

## Independent PostgreSQL-engine validation

No local PostgreSQL server/Docker was available. Installed PGlite 0.5.8 in `/private/tmp/proplane-limiter-review`, outside the repo, and ran an ephemeral in-memory PostgreSQL database with synthetic values. No cloud database was contacted.

**Limiter migration: 9 check groups passed.** Migration applies; anon/authenticated roles cannot call RPC or read table; 30 queued calls admit exactly 3 and saturated counter remains 3; independent buckets retain capacity; expired bucket resets; null/invalid/out-of-range arguments fail; expired-row cleanup executes; catalog confirms security-invoker and explicit search_path. Harness: `/private/tmp/proplane-limiter-review/review.mjs`.

**Backfill transactions: 5 check groups passed.** Using the actual helper transpiled in memory (server-only marker stubbed as in unit tests) with equivalent transaction SQL: dry run leaves both copies unchanged; corrupt second row rolls back the first-row update; apply encrypts active and stale fallback tokens; unrelated metadata survives; repeat apply is idempotent. The initial temp-transpile write failed with ENOSPC; the successful run evaluated transpiled modules in memory. No result from the failed attempt is counted as passed.

PGlite serializes one connection, so concurrent Promise.all calls are queued. These checks validate PostgreSQL syntax, grants and transactional behavior, **not multi-connection lock contention/load, a hosted schema migration or actual CLI execution against Supabase**. Dedicated staging must still verify the deployed schema and operational permissions.

## Encryption candidate re-review — 2026-09-05

Reviewed the integrated encryption changes relative to `932f29d1` and the final uncommitted application-normalization correction. This is a continuation of the Trail of Bits methodology review, not a paid Trail of Bits audit or certification. The reviewer also authored the identity/normalization implementation; a separate static reviewer checked its authorization and transaction boundaries. Scope is application encryption and access-preserving normalization, not a fresh whole-product audit.

**Disposition: no unresolved release blocker found in the reviewed correction.** Applicant identity authenticates against the exact persisted, case-sensitive record ID. Normalization decrypts the authorized original row and reseals under the new ID. The additive `20260906050000_application_record_normalization.sql` RPC locks and compares the originally authorized complete snapshot, refuses an occupied target, transfers document aliases and existing logical children, then deletes the old parent atomically. Resident writes select owner/property columns; a later consent read cannot replace the authorization snapshot. Failed GET normalization returns the actual original ID. Attachment object paths remain immutable, preserving folder validation and document AAD. Alias resolution still follows current actor/application authorization and never grants access itself.

Attacker cases reviewed include a different account occupying the canonical target; a transfer or identity edit between authorization and persistence; ciphertext copied to a case-variant record; a browser forging crypto metadata; and an authenticated browser invoking the service-only normalization RPC. No authorization is derived from the stored encryption origin, alias, trace ID or client-supplied owner. The manager browser cache's new browser-only registration guard preserves the existing account-switch purge while preventing server evaluation of a client reference. Shared pure setup-link exports retain server-only protection on token persistence and identity crypto. The integrated three chat routes preserve independent deny capacity and await the shared limiter; confirmation and tracing remain in the existing framework.

Reviewer reran five focused suites: **39 tests passed**, covering normalization, resident authorization/snapshot races, document authorization, browser cache and the server import boundary. The local actual-SQL PGlite harness validates ten normalization/provisioning groups, including alias preservation, cross-account collision refusal, stale/changed owner rejection, injected mid-transaction rollback and browser/service RPC grants. Earlier quantitative integration analysis found **55 shared limiter calls across 43 modules**, all awaited. Parent reports the final candidate's **7,569 unit tests and production build (368 pages, including TypeScript) passed**; these broader results were reported by the release owner, not rerun here.

Release remains conditional on matching migrations, keys and strict-read rollout checks plus the release owner's staging evidence. This reviewer performed no production writes or account enrollment. Logical child tables without foreign keys still permit a separate concurrent callback to insert an obsolete parent ID after normalization; existing children and FK-backed aliases are covered, but that callback race is a follow-up. Encryption does not cover arbitrary custom text, prior snapshots/generated copies, third-party screening records or backups, and does not defend against an attacker controlling the running application and its keys. MFA/access-hardening work is separate and is not represented as complete by this signoff.
