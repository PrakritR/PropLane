# Bugbot review — 2026-09-05

Scope: working-tree security changes over `f44f23a4`, reviewed under
`docs/ship-gate.md`. The existing Graphify graph was queried first; it points
partly into an older validation checkout, so findings below were verified against
the current source. This is a source/regression review, not a penetration test or
a production deployment sign-off.

## Findings sent to the implementation owner

1. **High, resolved in source — inbound messages could be permanently lost during limiter outages.**
   `src/lib/rate-limit.ts` returns `{ ok: false }` for both confirmed exhaustion
   and database/configuration/timeout failure. `src/app/api/twilio/inbound/route.ts`,
   `src/app/api/webhooks/twilio/sms/route.ts`, and
   `src/app/api/webhooks/email/inbound/route.ts` acknowledge exhausted requests
   with HTTP 200 before durable processing. With the new remote dependency,
   transient store failure now also acknowledges and discards legitimate messages.
   Expose unavailability separately and return a retryable 503 for that state;
   keep 200 shedding only for confirmed exhaustion. No unthrottled fallback.
   Follow-up verified `unavailable: true` and 503 handling in all three branches
   of the main Twilio route, the alternate SMS route, and both email limits.

2. **Medium, resolved in source — opportunistic expiration could not keep up with distinct buckets.**
   `supabase/migrations/20260906020000_shared_rate_limits.sql` initially cleaned
   at most 100 expired rows for 1/256 of hashed keys: at most 0.39 removals per new
   bucket on average, versus one insertion. Continually new callers therefore
   grow storage indefinitely. Increase cleanup frequency/capacity or add a
   scheduled expiry job and document retention monitoring. Follow-up verified
   cleanup increased to 1/16 of keys, giving expected capacity of 6.25 removals
   per distinct new bucket. This remains opportunistic: idle installations retain
   expired pseudonymous rows until traffic resumes.

3. **Recovery limitation — unreadable Google credentials hide the disconnect UI.**
   Although authenticated DELETE can clear unreadable credentials, a failed GET
   leaves `google-calendar-connect-panel.tsx` with null status and permanent
   “Loading…”/no panel. The normal Disconnect button is therefore unavailable.
   Reconnect also loads the unreadable old connection before saving fresh tokens.
   Provide an error-state disconnect/retry control or explicitly document
   authenticated DELETE/operator-assisted recovery; do not claim self-service
   recovery is covered by the helper test alone. Accepted scope: recovery remains
   operator-assisted for this change. An authenticated manager can issue DELETE
   to `/api/portal/google-calendar` under their own session; operators should
   restore the matching key before erasing credentials whenever recoverable.
   Erasure requires reconnecting Google afterward. Do not share session cookies
   or keys in support tickets. No UI recovery improvement is claimed.

## Reviewed boundaries

- All source call sites await the async limiter, including the pre-existing PDF
  parsing routes. Authentication and role/property scopes at those call sites
  remain in place. The shared RPC uses an atomic conflict update, service-role-only
  execution/table grants, RLS, and an empty search path.
- The new token envelope uses AES-256-GCM, random 96-bit nonces, 128-bit tags,
  canonical 256-bit key encoding, versioned keys, and owner/record/field-bound
  authenticated data. Both calendar storage modes encrypt writes and decrypt
  server reads; public status omits credentials. Explicit disconnect can erase
  corrupt ciphertext without possessing the lost key.
- Temporary legacy plaintext reads are explicit. Deploying without keys breaks
  credential writes; enabling encrypted-only reads before backfill breaks legacy
  credential reads. These are rollout prerequisites, not evidence of deployed
  encryption. TIN changes retain the old envelope/derivation while tightening
  malformed-input rejection.
- Co-signer sessionStorage is removed, new cached SSNs are masked, and failed
  server reads return no cached records. Sensitive answers still exist in memory;
  the broader application/browser-copy migration remains outstanding.
- Baseline headers retain same-origin frames and current lease PDF object URLs.
  The Capacitor shell loads the site as a top-level WebView. No microphone capture
  feature was found in source. This does not substitute for actual browser/native
  OAuth, upload, and PDF smoke testing. The CSP intentionally has no script policy
  and must not be described as comprehensive XSS protection.
- Direct Postgres helpers reject TLS-disable options and URL SSL overrides and
  verify certificates. Operator URLs/CA configuration must be updated and checked
  before deployment. Dependency manifests were checked for installed version and
  Node-engine compatibility; full build and dependency audit evidence belongs to
  the implementation validation record.

## Validation and release limits

`git diff --check` passed at review time. Parent reported 1,123 unit files /
7,410 tests passing; this reviewer did not rerun that full suite or independently
attest to its output. After the fixes, this reviewer added 12 regression cases
covering unavailable → 503 and confirmed exhaustion → 200 across all three
main Twilio paths, vendor SMS, and both email budgets. They also assert that no
agent/ingest handler runs for either denial state.

Executed:

```text
npx vitest run tests/unit/twilio-inbound-retry.test.ts tests/unit/inbound-email-webhook.test.ts tests/unit/security/vendor-sms-rate-limit.test.ts
3 files passed; 57 tests passed.
```

No production calls, implementation edits, or commits were made by this review.
Operational backfill/probe scripts were still being authored at the initial pass
and require a separate follow-up before their review closure.

**Follow-up disposition: initial blocker and cleanup finding resolved in source.
Webhook regression tests pass. Reviewed implementation has no remaining blocker;
operator-assisted calendar recovery is an explicit limitation. Operational scripts
still await final review and production release still requires rollout/QA evidence.**
