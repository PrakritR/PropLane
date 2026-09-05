# Dedicated release review — 2026-09-05

Reviewed baseline `07b8070e` plus the working-tree R1 server boundary, required
GET Request signature and R2 application normalization correction. The final
commit and deployed staging candidate must be recorded with browser evidence.

## Disposition

**No unresolved Critical/High finding in the reviewed encryption changes.** The
code is ready to land on main and proceed to staging QA. This is a code-review
disposition, not production QA approval or a penetration-test certification.

- R1 registers the application-cache identity listener only in the browser.
  Server imports can use pure ID helpers without invoking React client
  references. Browser identity changes still cancel queued writes, clear
  sensitive caches and discard stale asynchronous responses. Demo and anonymous
  draft behavior retain their separate checks.
- The required `GET(req: Request)` matches the Next route contract. Existing
  ownership, resident self-scope and denial behavior are retained.
- R2 carries the exact previously authorized application snapshot into a
  service-only PostgreSQL function. Its row lock and snapshot comparison reject
  intervening changes. A conflicting destination PK is never overwritten.
  Applicant identity is resealed for the new exact PK; aliases and logical
  co-signer/screening/waiver references move before the old parent is deleted.
  Object paths and document authentication context stay unchanged. The sequence
  rolls back together on failure. The co-signer's own crypto record ID stays
  unchanged. Failed normalization returns the surviving original PK.
- Application upload/download remains scoped to the stored application's
  current owner/applicant permissions. The server master key never reaches the
  browser. Protected document paths require authenticated decryption; failures
  cannot return plaintext. Legacy aliases are resolved only after authorization.

## Cache, rendering and native review

Sensitive application/co-signer reads and document signing/download responses
use `private, no-store`. Sensitive applicant/co-signer caches are memory-only and
cleared on account changes. Large files retain browser-to-Storage transport with
the 15 MB original limit plus envelope allowance, avoiding a new serverless
request-body bottleneck. The browser-safe protocol and URL-only setup helpers
keep server key and token-persistence modules out of client execution.

Website and native WebViews use the same upload component, file/camera callbacks
and preview routes. MIME metadata, PDF handling and image/HEIC serving paths are
preserved. This change adds no portal navigation or deep-link differences.
Installed Playwright WebKit launches successfully (engine 26.5); actual staging
Chromium/WebKit uploads are prepared but have not yet run. Viewport/engine testing
does not establish physical iOS/Android camera behavior.

## Validation evidence

- Independent targeted R1/ownership check: 3 files, 14 tests passed
  (`applicant-server-boundary`, `applicant-browser-cache`, and
  `manager-applications-owned-property-fallback`).
- Root reports the full 7,569-test suite green and the resumed build successful,
  including TypeScript and all 368 pages. Build log:
  `/private/tmp/proplane-security-build-resumed.log`.
- Reviewed R2 crypto/alias regression coverage and isolated PostgreSQL rehearsal:
  occupied target, stale ownership/snapshot, draft downgrade, failure rollback,
  service-only invocation, and exact migration history. Hosted migration
  installation remains a deployment prerequisite.
- The bounded staging runner is
  `/private/tmp/proplane-staging-security-qa.ts`. It records the full candidate
  SHA, uses only generated users/property/application/co-signer/documents, and
  deletes its exact fixtures. It covers 15 MB PDF upload/roundtrip, Chromium and
  WebKit mobile PNG/PDF preview, cross-account denials, identity encryption,
  browser-cache privacy, upload retry and malformed-envelope failure.

## Release conditions and limits

Dedicated production QA signoff is **pending** the pinned staging deployment,
matching migrations/key configuration, synthetic browser results and strict-read
cutover evidence. No production deployment or data mutation was performed by
this reviewer.

The development probe showed that an ordinary cached download can return a
deleted original even after its authoritative Storage row is gone and a fresh
authenticated request returns not found. Existing-file protection claims must
account for cache expiry/invalidation; deletion is not immediate global cache
erasure. Downloaded copies, backups and separately scoped manager/vendor/inbox
documents remain outside this application-document boundary.

The public co-signer submission contract currently uses the parent application
ID and submitted-state gate, without an invitation-token binding. This is an
existing security-review follow-up, not a property established by these
encryption tests. The synthetic smoke disables notifications using only its
generated owner's blank profile email, held until teardown; it performs no
provider sends or live screening/calendar synchronization.

## CI test synchronization follow-up

Main CI run `33997444356` passed integration, lint, build and browser smoke, but one of 7,569 unit tests raced the PDF renderer's final event-loop yield. The test published all three images before loading-state finalization. Its final loading-removal assertion now uses `waitFor`, retaining the same expected result and all image/truncation assertions. All nine focused preview tests pass. Bugbot and security-review independently approved the test-only change; application source is unchanged.
