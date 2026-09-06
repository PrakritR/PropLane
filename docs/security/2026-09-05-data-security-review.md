# Sensitive-data security review — 2026-09-05

## Executive summary

**Baseline:** `f44f23a4`. **Recommendation:** conditional; improve the narrow boundaries below first, then complete the application/document migration before claiming that a stolen database or object export cannot reveal customer information.

This is a bounded source review using the installed Trail of Bits differential-review methodology and insecure-defaults weak-crypto/fail-open reference corpus. It is **not an audit conducted by Trail of Bits**, a penetration test, or the output of its automated insecure-defaults workflow. No such workflow command ran. The methodology is adapted to a baseline gap assessment; unrelated dirty UI and agent work is excluded. Implementation changes made after this baseline need their own validation.

| Baseline finding | Priority | Confidence |
| --- | --- | --- |
| Applicant identity answers are readable in database JSON | High | High |
| Calendar OAuth credentials are readable in database JSON | High | High |
| Browser mirrors retain sensitive answers, including original co-signer SSNs | High | High |
| TIN encryption lacks versioned key rotation and record binding | Medium | High |
| Traces/replay need an explicit sensitive-data minimization and retention review | Medium | High for code paths; provider configuration unverified |

These are confidentiality/control gaps under the threat models below, **not proof of an existing unauthorized external read or breach**. No new unauthenticated read bypass was established in this review. Production database/storage policies, key configuration, accounts and customer rows were not inspected.

## What encryption can promise

- **Stolen physical disks:** infrastructure encryption at rest addresses this threat when the hosting provider configures it correctly. This report does not independently attest to deployed infrastructure settings.
- **Stolen logical database export or database credentials:** disk encryption does not stop authorized database software from returning readable rows. Sensitive-field encryption with a separately controlled application key can protect those fields if the attacker lacks that key and cannot invoke an authorized decryption path.
- **Compromised application runtime or authorized user account:** the running application can decrypt data it is allowed to show. Field encryption alone does not stop that attacker. Least privilege, role/property scoping, MFA, monitoring and data minimization remain necessary.
- **Stolen documents:** encrypting database fields does not encrypt document bytes, generated exports, old backups, browser caches or observability copies. All copies must be covered before making an all-data claim.

Never say “even if anyone gets access, they cannot use the data,” “end-to-end encrypted,” “zero knowledge,” or “audited by Trail of Bits” on this evidence.

## Existing controls confirmed in code

1. `src/lib/reports/tin-crypto.ts:3` requires a configured secret; lines 11–27 encrypt/decrypt TINs with AES-256-GCM and a fresh 12-byte nonce. Missing configuration throws; there is no plaintext fallback. Manager/vendor tax routes store `tin_ciphertext` and expose last-four projections (`src/app/api/manager/tax-profile/route.ts:60`, `src/app/api/vendor/tax-profile/route.ts:97`, `src/app/api/vendors/[id]/tax-profile/route.ts:78`). Configuration and existing rows in production remain unverified.
2. Applicant document storage is declared private, with no permissive client object policy (`supabase/migrations/20260727120000_application_documents_bucket.sql:18`). The API authorizes against stored ownership and current property access; guest writes require the stored setup token (`src/lib/rental-application/application-photos.server.ts:49`, `:158`). Document bytes are returned with `private, no-store` (`src/app/api/portal/application-photos/route.ts:314`). This is access control, not application-key encryption of bytes.
3. Manager documents use a private bucket and owner-prefix policy (`supabase/migrations/20260711120000_manager_documents.sql:82`). Signed URLs last 600 seconds; the signing helper validates that the object path belongs to the stored owner (`src/lib/documents/document-signed-url.server.ts:8`, `:40`). Its manager route checks owner or current documents-module property permission before signing (`src/app/api/manager-documents/[id]/signed-url/route.ts:33`). A shared signed URL remains usable until expiry.
4. Applicant API reads authenticate the caller and scope resident reads to the authenticated email, manager reads to authorized applications and admin reads to admin status (`src/app/api/manager-applications/route.ts:540`). Encryption must preserve and strengthen these checks, never replace them.
5. The public co-signer route masks SSNs to last four before database insertion (`src/app/api/public/cosigner-submissions/route.ts:16`). The wizard draft store is memory-only, with only the public resume reference kept in sessionStorage (`src/lib/rental-application/drafts.ts:5`, `:50`). Other browser mirrors below undermine complete minimization.
6. Calendar browser responses use a token-free projection (`src/lib/google-calendar/settings.ts:40`). Application agent tools intentionally omit the raw application form and screening reports (`src/lib/tools/domains/applications.ts:28`, `:114`). This reduces exposure to model/trace systems but does not redact arbitrary user-supplied messages.

## Findings and feasible fixes

### DSR-01 — High: applicant identity fields lack application-key encryption

`RentalWizardFormState` includes `dateOfBirth`, `ssn`, and `driversLicense` (`src/lib/rental-application/types.ts:81`). `persistNormalizedRow` writes the entire row to `row_data` without a cryptographic transform (`src/app/api/manager-applications/route.ts:115–132`); `normalizeRow` preserves the nested form (`:40`). Reads return the form to appropriately scoped callers (`:599–645`). The co-signer route masks SSN but writes DOB/license and other answers as readable JSON (`src/app/api/public/cosigner-submissions/route.ts:60–98`).

**Attack scenario:** an attacker obtains a logical dump or database-level read permission without access to application secrets. They read `manager_application_records.row_data.application`; the protected-at-rest disk transparently yields readable identity answers. No remote route bypass is asserted.

**Blast radius:** 79 source files mention the applicant table; 11 mention the co-signer table; their union is 80. These are textual table-reference counts, not exact call-graph reachability counts. The graph query was truncated and included an older worktree, so live source searches establish these counts.

**Why a main-route-only patch is unsafe:** direct reads/writes also exist in screening (`src/lib/checkr/background-check.ts:161`, `:176`, `:527`, `:544`), guest resume (`src/app/api/portal/application-resume/route.ts:66`), PDF generation (`src/app/api/manager-applications/[id]/pdf/route.ts:53`, `:96`) and resident autofill (`src/lib/rental-application/resident-application-autofill.server.ts:22`). Whole-row state updates can overwrite encrypted data or restore plaintext. UI list mirroring re-sends complete snapshots.

**Boundary:** this is a broader migration, not safely completed by wrapping one endpoint this session. First centralize sensitive-field encode/decode behind a server-only repository; inventory every table writer; maintain separately scoped, minimal projections for lists/tools. Decrypt only after deriving landlord/role/property or resident ownership server-side. Use authenticated encryption with version/key ID and owner/table/record/field associated data. Preserve plaintext-reader compatibility only during a measured backfill, then remove it. Test concurrent writes, draft resume, owner reassignment, screening, PDFs, exports and wrong-owner decryption. Backfill and audit counts without emitting values. Include copies and backups in the retention plan.

### DSR-02 — High: calendar credentials lack application-key encryption

`src/lib/google-calendar/settings.ts` is the sole direct `google_calendar` field reader/writer found in `src`. Both access and refresh tokens are returned unencrypted by the normalizer (`:26–35`) and stored as part of `next` in the dedicated column (`:216`) or compatibility `row_data.google_calendar` field (`:245`).

**Attack scenario:** the same database-read attacker extracts the refresh token and, if they also satisfy the provider's client authentication requirements, exchanges it for calendar access. An unexpired access token can be used directly within its provider scopes. Database encryption without a separate application key does not mitigate this.

**Finite implementation boundary:** decrypt after both load paths (`:100`, `:196`), encrypt the two token fields before both save paths (`:216`, `:245`), and return the plaintext normalized connection only to server callers. Ten source files reference load/save helpers. Keep public status token-free. Bind ciphertext to manager ID and field with authenticated associated data; require a random, validated key; fail closed for malformed ciphertext/missing key. Preserve legacy plaintext reads temporarily and separately backfill both storage modes. Do not silently fall back to writing plaintext when configuration is absent. A deployed key and completed backfill are prerequisites for claiming existing tokens are protected.

### DSR-03 — High: sensitive browser copies outlive their immediate use

Co-signer successful submission appends the **original** input (including full SSN) to its cache (`src/lib/cosigner-submissions-storage.ts:111`), despite the server's masked database copy. `persist` serializes the complete cache into globally named `axis:cosigner-submissions:v1` sessionStorage (`:62`, `:84`). On a failed or unauthorized fetch, the client returns its local fallback (`:131–138`). Four source files consume the cache helpers.

The manager application mirror serializes full rows into per-user sessionStorage (`src/lib/manager-applications-storage.ts:336–344`). Per-user scoping is useful, but does not encrypt those values. A malicious same-origin script or access to an open browser session can read them. No XSS entry point was proven here.

**First fix:** mask/drop original co-signer SSN before any cache insertion; migrate or remove legacy cached values; return no cached rows after an explicit 401/403; prefer no durable browser cache for identity answers. For the manager mirror, move sensitive data to authorized on-demand fetches or memory, taking care that redacted list rows cannot overwrite canonical form answers via whole-row autosave. Do not encrypt browser storage with a key shipped to that same browser and describe it as theft protection.

### DSR-04 — Medium: TIN key rotation and record binding need a migration

The existing TIN helper hashes any non-empty configured string to a key (`src/lib/reports/tin-crypto.ts:3–8`). A short operator-chosen string therefore has low entropy despite AES-256-GCM. No production key weakness was verified. Ciphertext has nonce/tag/data but no key ID/version or row/tenant associated data. Changing the sole key makes old values unreadable; database write access could substitute another valid ciphertext because it is not bound to the row.

Use generated 256-bit keys, separate secret storage, a versioned keyring and explicit record binding for new writes, plus a legacy decoder/backfill path. Do not change derivation or require new AAD for old ciphertext without migrating it. Confirm the restore procedure includes keys, recovery access and old-backup retention. Historical guard: commit `eef42b21` introduced the missing-key refusal; never remove it.

### DSR-05 — Medium: observability is an additional data store

Langfuse intentionally records user input, LLM input/output, tool arguments and tool output (`src/lib/observability/langfuse.ts:192–216`, `:526`, `:605–612`). An applicant can paste sensitive data into chat even when tool projections are safe. `instrumentation-client.ts:3` enables product analytics/exceptions without an explicit application-level sensitive-surface masking policy; provider defaults and production project settings were not reviewed. This is **not proof that a specific secret was sent to PostHog**.

Inventory and minimize sensitive content before observability export; preserve required session/landlord attribution, event coverage and useful diagnostics. Explicitly configure and validate input masking, sensitive-page replay exclusion or masking, URL/query sanitization, trace access and retention. Test with synthetic canaries and inspect provider output. Coordinate this with `docs/observability.md`; do not simply disable required instrumentation. Database field encryption does not protect plaintext copies already sent to these services.

## Historical context and validation

- Co-signer database SSN masking: blame `065f6d600` (2026-06-26).
- Co-signer browser persistence: blame `3ab3b7cd4` (2026-05-01).
- Calendar row-data fallback persistence: blame `adb5242bc` (2026-07-24).
- TIN missing-secret guard: blame `eef42b21c` (2026-06-26).
- No security code was removed by this review; no patch regression conclusion is implied.

Executed in the isolated implementation worktree:

```text
npx vitest run tests/unit/reports/tin-crypto.test.ts tests/unit/application-photo-access.test.ts tests/unit/google-calendar-settings.test.ts tests/unit/observability/langfuse-observer.test.ts
4 test files passed; 37 tests passed.
```

These baseline tests demonstrate the tested behaviors only. Existing TIN tests cover roundtrip/missing key, not versioning, rotation, record binding or production key management. They do not establish that production RLS is correct, a backfill has completed, all storage is encrypted with an application key, or all third-party retention policies meet the desired standard.

## Ordered implementation and release criteria

1. Complete dependency/header/rate-limit hardening in the companion implementation; this review does not cover it.
2. Implement the finite calendar-token encryption boundary and co-signer cache minimization, with synthetic regression tests.
3. Configure separate keys in dev/staging, validate bad/missing key behavior, exercise OAuth reconnect/refresh/disconnect and both schema modes. Inventory/backfill existing tokens with counts only. A preview implementation is not evidence of live protection.
4. Complete the applicant/cosigner repository migration and sensitive-browser-copy removal, then encrypt private document bytes if database/object-export theft is in scope. Direct signed-upload/signed-download designs need adaptation for application-managed ciphertext; account for HEIC previews, PDFs, parsing, downloads and mobile parity.
5. Verify production RLS/storage privacy, privileged MFA, independently controlled key access, backup restore and observability retention using deployment evidence. Apply the required main → staging → dedicated QA → production ladder.
6. Write customer assurances only from controls actually deployed and verified. Prefer specific statements about encrypted connections, restricted access, private documents, and the precise data categories receiving additional encryption. Do not claim all records are application-key encrypted until the migration and copies/backup audit are complete.
