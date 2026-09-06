# Application document encryption — implementation record

## Implemented boundary

New application ID/income-photo uploads are encrypted **before bytes reach
Storage**, while retaining the existing direct signed-upload transport and 15 MB
original-file limit. Large phone captures do not move through a Vercel request body.

- The authenticated/setup-token-authorized signer generates a random 256-bit
  **per-object** data key. The existing server application key wraps that key and
  the authorized original size. The master key never reaches the browser.
- The upload response is `private, no-store`. Its per-object key exists only in
  the upload's memory; autosave callbacks receive only the original path/display
  metadata. WebCrypto encrypts the binary document with AES-256-GCM, a random
  96-bit nonce and 128-bit tag before direct Storage upload.
- Both wrapping and document authentication bind the exact object path and
  immutable application folder. Property reassignment does not make an authorized
  document unreadable; current actor/property/resident scope still authorizes
  every server read. Encryption context is never an authorization grant.
- New paths end in `.penc` and always require the fixed versioned binary envelope.
  Wrong keys, wrong paths, corrupt metadata/ciphertext/tags, mismatched signed
  sizes and plaintext at protected paths fail closed. Filenames, ciphertext and
  keys are absent from cryptographic error messages.
- Authorized GET decrypts before existing PDF/image/HEIC preview handling and
  retains `private, no-store`. Camera and file-picker callbacks preserve original
  MIME/size and share the same website/native WebView code. Old open tabs must
  refresh before the signer issues a new upload token.
- The upload signer's independent memory/IP limiter now uses the existing shared
  limiter and trusted IP helper. Folder checks also reject nested/encoded traversal.

No new agent surface or tool was introduced. Existing upload interaction
attributes remain in place; signing a URL is not falsely recorded as a completed
upload. No document/key bytes are added to analytics or agent traces by this change.

## Legacy references and backfill

`application_document_storage_aliases` is RLS enabled and service-role-only.
It maps an original path to a new protected path under the **same** application
folder. GET authorizes the original stored attachment before consulting the map;
alias lookup failure never falls back to old bytes. Old autosaves can therefore
retain their original references without restoring plaintext reads. DELETE removes
both paths; application deletion reclaims the complete folder and cascades aliases.

`scripts/security/backfill-application-documents.ts` is limited to the configured
development/staging projects and defaults to dry-run. It uses the existing
verified-TLS nonproduction connection helper and prints aggregate counts only.
Inventory, object migration, and cleanup bookkeeping each establish transaction-
local `postgres` role scope so pooler connections do not depend on inherited grants.

```sh
node --conditions=react-server --env-file=.env.security-dev.local --import tsx scripts/security/backfill-application-documents.ts
# Explicit mutation, ONLY after schema and key setup/review:
node --conditions=react-server --env-file=.env.security-dev.local --import tsx scripts/security/backfill-application-documents.ts --apply
```

For each legacy object, apply locks the application row, uploads an independently
named encrypted replacement, downloads and verifies exact decrypted-byte equality,
commits the alias, and only then removes the plaintext original. It does not update
application answers or attachment references. Upload/verification/alias failures
retain the original and attempt to remove an uncommitted replacement. An ambiguous
COMMIT response retains both objects because the alias might already be durable.
Retries verify existing aliases and resume original cleanup without a second upload.
Failed cleanup produces a nonzero exit and `cleanupPending` count.

Removing the original Storage object is not evidence that every cached copy has
expired. The live synthetic development probe observed a successful ordinary
download of the old plaintext URL immediately after removal, even though an exact
`storage.objects` query found no original and a cache-busted authenticated request
returned not found. The authorized application download route sends
`private, no-store`, but this does not retroactively change an original Storage
response's cache policy. Existing-file rollout must account for original response cache
lifetimes and verify expiry/invalidation before claiming old plaintext URLs no
longer work. Supabase documents Storage's
[CDN caching](https://supabase.com/docs/guides/storage/cdn/fundamentals) and notes
that even [Smart CDN deletion invalidation](https://supabase.com/docs/guides/storage/cdn/smart-cdn)
can take time; that plan-specific timing is not a verified guarantee for this
environment. Downloaded client copies and backups require separate retention work.

This is not a cross-service atomic transaction: operator reconciliation is required
after ambiguous commit or failed cleanup. The scan covers folders belonging to
**existing application rows**, including unreferenced objects in those folders.
Deleted-application/orphan folders, old exports and provider backups require their
own retention inventory. Protected objects encountered in the scan are downloaded
and authenticated; they are not counted solely by filename extension. A full scan
incurs Storage download/egress for the selected documents.

## Required rollout sequence

1. Configure distinct server application keys in the target environment.
2. Apply `20260906030000_application_document_envelopes.sql` (private bucket,
   octet-stream and 4 KB envelope allowance) and
   `20260906031000_application_document_aliases.sql` before deploying these routes.
3. Deploy through main/staging, exercise signed upload, authorized read, guest
   denial, retake/delete, PDF, HEIC preview and native camera/file picking.
4. Run dry-run, review counts, then explicit dev/staging backfill and rerun to
   verify no legacy objects/cleanup failures in the covered folders.
5. Set `DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS=true` only after migration
   evidence and QA; default compatibility accepts legacy objects at unprotected
   paths. Aliased old references continue to work with this flag enabled.
6. Production migration needs its own reviewed operator path and dedicated staging
   QA approval. This script deliberately cannot mutate production.

## Remaining private document coverage

Manager documents are **not** encrypted by this change. Their server writes are
`src/app/api/manager-documents/route.ts` and
`src/lib/documents/document-auto-file.server.ts`; reads use
`src/lib/documents/document-signed-url.server.ts` with 600-second direct Storage
URLs, shared by manager/resident/vendor routes. Replacing their bytes with
ciphertext alone would break previews, downloads, shared links and auto-filed
documents. Their migration requires a coherent authorized decrypt/download or
browser-envelope flow across those consumers. Vendor documents, inbox attachments,
lease templates and generated/exported copies likewise remain separate boundaries.

## Validation

Executed locally against synthetic data:

```text
npx vitest run tests/unit/security/application-document-backfill.test.ts tests/unit/security/application-document-route.test.ts tests/unit/security/application-document-upload.test.tsx tests/unit/security/application-document-encryption.test.ts tests/unit/application-photo-access.test.ts tests/unit/application-photo-preview.test.ts tests/unit/platform-parity.test.ts
7 files passed; 83 tests passed.
```

Targeted ESLint and `git diff --check` passed. A prior TypeScript run reported only
an in-progress sibling-lane Checkr call-signature error; final aggregate typecheck
belongs to the root validation. Tests include binary roundtrip, the full 15 MB
size ceiling, wrong application/path, malformed uploads, exact PDF MIME/bytes,
guest/setup-token and manager access, camera/file callbacks, stale alias references,
rollback, ambiguous commit and cleanup retry. Actual browser/native/device QA is
still required.

## Hosted development probe

`scripts/security/probe-application-document-dev.ts` requires explicit `--apply`
and the exact canonical development project URL. It uses the bundled public CA
with verified TLS, reuses only an exact test-manager email match (or creates and
removes its own confirmed synthetic auth user without sending email), and writes
only a unique application marker and tiny synthetic PDF. It calls the real
backfill helper and removes its exact synthetic application, aliases and objects
in `finally`; no account-wide purge, customer mutation or staging/production
backfill occurs.

The live probe passed: ciphertext decrypted to the original bytes, attachment
references stayed stable through the alias, anonymous alias access was denied,
the exact original was absent from `storage.objects`, and a cache-busted
authenticated download returned not found. The canonical test manager was reused,
so no auth user was created. All synthetic object/application cleanup checks
passed. Evidence contains counts and booleans only:
[`2026-09-05-application-document-dev-probe.json`](2026-09-05-application-document-dev-probe.json).
The preceding attempt is retained in
[`2026-09-05-application-document-dev-probe-first-attempt.json`](2026-09-05-application-document-dev-probe-first-attempt.json):
it correctly failed an immediate download-removal assumption, prompting the
authoritative origin and fresh-request checks above. Both attempts observed the
stale ordinary download; this is a rollout limitation, not a claim of global cache
erasure. Both attempts cleaned up their synthetic fixtures.
