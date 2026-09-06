# Applicant and co-signer identity encryption boundary — 2026-09-05

## Implemented co-signer slice

The new server-only boundary protects the existing masked SSN, date of birth and driver/license number in `cosigner_submission_records.row_data`. It does not begin retaining a full SSN. AES-256-GCM uses the shared versioned keyring with AAD bound to purpose, immutable row ID, field and a trusted origin-owner namespace. `_identityProtection` is server-created cryptographic metadata, never an authorization claim. Current application ownership determines access independently, so account/property transfers do not make ciphertext undecryptable or grant the original owner continuing access. Public input is reconstructed and cannot supply this metadata.

| Surface | Treatment |
| --- | --- |
| Public co-signer POST | Seals identity before insert; rejects missing manager/keys; response contains only status/id |
| Co-signer GET | Existing session/resident/manager authorization first; current module permission checked for linked managers; opens identity; private,no-store |
| Application PDF route | Existing manager/resident/admin application authorization first; opens co-signer fields before PDF rendering |
| Checkr co-signer read | Repository re-derives current parent manager before opening, including prepaid retry paths |
| Checkr co-signer write | Rechecks parent owner, preserves origin namespace and reseals identity |
| Screening report/checkout status routes | Read only backgroundCheck or ownership metadata; no identity decryption needed |
| Property transfer / auth user-ID migration | Change current ownership columns; leave immutable crypto namespace intact |
| Purge functions | Delete rows; no decryption required |
| Browser co-signer cache | Earlier hardening removed persistent cache and full-SSN caching; authorized full identity is transient when needed by detail/PDF UI |

No listing, document object path, consent or background-check metadata is encrypted by this slice. Private attachment bytes are a separate workstream. Normal existing role/property authorization remains necessary; possessing an origin namespace or ciphertext is not permission.

## Co-signer rollout and limitations

- Configure DATA_ENCRYPTION_ACTIVE_KEY_ID / DATA_ENCRYPTION_KEYS_JSON before deploying new writers. Do not log keys, plaintext identity or ciphertext values.
- `tsx --conditions=react-server scripts/security/backfill-cosigner-identities.ts` defaults to dry run. `--apply` is restricted to declared dev/staging endpoints with verified TLS. The row-locking transaction encrypts existing fields, rotates old-key values, rejects corrupt rows and rolls back on error. Output contains aggregate counts only. Unassigned legacy rows must have ownership resolved before applying; the backfill will not invent an owner.
- Run a second dry run and verify zero plaintext fields, then set COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS=true. Every new identity write is encrypted regardless of that read-compatibility flag. Old backups remain outside the migration.
- Dedicated staging must exercise public submit, manager/resident access, linked-manager permissions, PDF export, screening and transfer. No production key provisioning, migration or deployment was performed by this subtask.

## Implemented canonical applicant identity boundary

The server-only `applicant-identity.ts` codec removes `application.ssn`, `dateOfBirth` and `driversLicense` from persisted form JSON and stores their authenticated encrypted aggregate in `_applicantIdentity`. AAD binds the exact persisted application primary key (case-sensitive), purpose and trusted origin manager. Alias lookup is allowed, but opening always uses the returned database ID. Authorized ID normalization explicitly opens the old row then seals under the new ID; distinct case-variant keys cannot share an envelope. Current owner authorization is independent of that origin namespace. Client/model-supplied crypto metadata is stripped, and only missing identity properties are restored from the trusted existing row after authorization. Explicit clearing remains possible. Custom answer keys and attachment metadata are preserved without pretending their free text is protected by this three-field codec.

All direct runtime row_data mutation paths listed below either seal at the explicit write boundary or delete the row. Whole-row background/status/date/token/housing edits validate and reseal existing ciphertext. Account/property ownership migrations update ownership columns and preserve the encrypted sidecar. These are explicit calls, not a generic Supabase interceptor.

Authorized main API GET, resume-token response, account setup, application PDF, resident autofill, Checkr and Certn paths open identity at their row boundary. Public share rendering stays an allowlisted summary and does not decrypt identity. Metadata-only queries keep the sidecar opaque and do not return it to browser/tool callers. Checkr and Certn read helpers check current manager_user_id before opening, including prepaid retries. A null current parent owner is an unassigned state and cannot fall back to stale JSON/child ownership stamps. The resident POST additionally rejects a stored row whose resident_email/email differs from the authenticated applicant: checking only the incoming email previously allowed a resident to claim another pending row ID. Lease amendment synchronization now matches the current lease manager on both the applicant read and write.

The following inventory records the original pre-change source locations; line numbers move with these changes. Counts are textual source references, not claimed complete semantic graph coverage.

| Source location | Mutation |
| --- | --- |
| `src/app/api/manager-applications/route.ts:93` | update |
| `src/app/api/manager-applications/route.ts:104` | insert |
| `src/app/api/manager-applications/route.ts:131` | upsert |
| `src/app/api/manager-applications/route.ts:138` | delete |
| `src/app/api/manager-applications/route.ts:822` | update |
| `src/app/api/portal/purge-orphaned-records/route.ts:164` | delete |
| `src/app/api/portal/send-application-started/route.ts:136` | update |
| `src/app/api/portal/send-manager-application-started/route.ts:162` | update |
| `src/lib/auth/clear-property-housing-access.ts:154` | update |
| `src/lib/auth/clear-property-housing-access.ts:179` | update |
| `src/lib/auth/purge-orphaned-portal-records.ts:197` | delete |
| `src/lib/auth/purge-portal-account-data.ts:71` | delete |
| `src/lib/auth/purge-portal-account-data.ts:104` | delete |
| `src/lib/auth/purge-portal-account-data.ts:124` | delete |
| `src/lib/auth/purge-portal-account-data.ts:156` | delete |
| `src/lib/auth/resident-setup-token.ts:184` | upsert |
| `src/lib/auth/resident-setup-token.ts:205` | upsert |
| `src/lib/auth/resident-setup-token.ts:266` | upsert |
| `src/lib/checkr/background-check.ts:171` | upsert |
| `src/lib/demo/canonical-demo-portfolio-db.ts:159` | upsert |
| `src/lib/existing-resident-onboarding.server.ts:168` | update |
| `src/lib/lease-amendment.server.ts:221` | update |
| `src/lib/screening/order-screening.ts:72` | upsert |
| `src/lib/tools/domains/applications.ts:231` | update |
| `src/lib/tools/domains/residents.ts:418` | update |

Observed 25 direct mutation sites across 15 runtime source files; 80 source files reference the applicant table.

### Generic writers and operational paths

- `src/lib/property-ownership-transfer.ts`: generic ownership-column updates for property_id and assigned_property_id. Transfer can change the current authorized manager independently from row_data snapshots.
- `src/lib/auth/migrate-portal-user-id.ts`: generic ownership-column migration; the origin namespace survives account merges independently from current authorization.
- `src/lib/demo/canonical-demo-portfolio-db.ts`: synthetic portfolio upsert; synthetic upserts now seal identity with the configured key just like runtime writes.
- Setup-token reissue/consume/relink, notification stamps, housing removal, onboarding, lease amendment and screening all replace complete row_data snapshots. Each now seals at the explicit applicant row_data write boundary.
- Agent writes in applications/residents domains use the existing confirmed tool framework. Only their row_data persistence calls gained the codec; permission checks, preview/confirm contracts, trace behavior and the single framework remain unchanged. No raw identity is newly returned to model tools or added to product analytics.

### All runtime source files referencing applicant table

- `src/app/api/auth/resident-setup-link/route.ts`
- `src/app/api/cosigner-submissions/route.ts`
- `src/app/api/cron/send-move-in-reminders/route.ts`
- `src/app/api/manager-applications/[id]/pdf/route.ts`
- `src/app/api/manager-applications/route.ts`
- `src/app/api/portal/application-photos/route.ts`
- `src/app/api/portal/application-resume/route.ts`
- `src/app/api/portal/delete-resident-access/route.ts`
- `src/app/api/portal/onboard-existing-resident/route.ts`
- `src/app/api/portal/purge-orphaned-records/route.ts`
- `src/app/api/portal/resident-approval/route.ts`
- `src/app/api/portal/resident-property/route.ts`
- `src/app/api/portal/send-application-completion-reminder/route.ts`
- `src/app/api/portal/send-application-started/route.ts`
- `src/app/api/portal/send-application-submitted/route.ts`
- `src/app/api/portal/send-inbox-message/route.ts`
- `src/app/api/portal/send-manager-application-started/route.ts`
- `src/app/api/property-records/route.ts`
- `src/app/api/public/approved-room-occupancy/route.ts`
- `src/app/api/public/cosigner-submissions/route.ts`
- `src/app/api/screening/background-check/document/route.ts`
- `src/app/api/screening/background-check/route.ts`
- `src/app/api/screening/checkout/route.ts`
- `src/app/api/screening/checkout-verify/route.ts`
- `src/app/api/screening/order/route.ts`
- `src/lib/application-group-document.server.ts`
- `src/lib/auth/clear-property-housing-access.ts`
- `src/lib/auth/complete-resident-signup-oauth.ts`
- `src/lib/auth/migrate-portal-user-id.ts`
- `src/lib/auth/provision-resident-account.ts`
- `src/lib/auth/purge-orphaned-portal-records.ts`
- `src/lib/auth/purge-portal-account-data.ts`
- `src/lib/auth/resident-relationship.ts`
- `src/lib/auth/resident-setup-token.ts`
- `src/lib/auth/resolve-oauth-portal-access.ts`
- `src/lib/checkr/background-check.ts`
- `src/lib/claw-maintenance-work-order.server.ts`
- `src/lib/claw-resident-actions.server.ts`
- `src/lib/claw-resident-messaging.server.ts`
- `src/lib/claw-service-request-sms.server.ts`
- `src/lib/demo/canonical-demo-portfolio-db.ts`
- `src/lib/demo/demo-agent-context.ts`
- `src/lib/demo/demo-portal-mirror.server.ts`
- `src/lib/existing-resident-onboarding.server.ts`
- `src/lib/inbox-recipient-scope.ts`
- `src/lib/lease-amendment.server.ts`
- `src/lib/lease-manager-filed-document.server.ts`
- `src/lib/manager-attention-digest.server.ts`
- `src/lib/manager-sms-messages.server.ts`
- `src/lib/portal-inbox-delivery.ts`
- `src/lib/portal-record-share-authorize.server.ts`
- `src/lib/portal-record-share-payload.server.ts`
- `src/lib/property-ownership-transfer.ts`
- `src/lib/reminders/current.server.ts`
- `src/lib/reminders/subjects/applications.server.ts`
- `src/lib/rental-application/application-policy.server.ts`
- `src/lib/rental-application/cosigner-signer-link.server.ts`
- `src/lib/rental-application/duplicate-application.server.ts`
- `src/lib/rental-application/group-leader-link.server.ts`
- `src/lib/rental-application/resident-application-autofill.server.ts`
- `src/lib/repair-service-request-scopes.server.ts`
- `src/lib/reports/display-context.ts`
- `src/lib/resident-document-import/parse-resident-document.server.ts`
- `src/lib/resident-manager-scope.ts`
- `src/lib/resident-move-in-info.ts`
- `src/lib/resident-portal-access-types.ts`
- `src/lib/resident-portal-access.ts`
- `src/lib/resident-welcome.server.ts`
- `src/lib/screening/order-screening.ts`
- `src/lib/security/cosigner-repository.ts`
- `src/lib/sms/application-consent.server.ts`
- `src/lib/tools/domains/applications.ts`
- `src/lib/tools/domains/charges.ts`
- `src/lib/tools/domains/messaging.ts`
- `src/lib/tools/domains/profile.ts`
- `src/lib/tools/domains/resident/lease.ts`
- `src/lib/tools/domains/resident/services.ts`
- `src/lib/tools/domains/residents.ts`
- `src/lib/tools/domains/search.ts`
- `src/lib/tools/domains/work-orders.ts`

### Operational scripts referencing applicant table

These are an additional execution inventory, not a claim that every script writes identity. Legacy backfills/seeds must not be rerun against encrypted live data without review.

- `scripts/import-sep-occupancy-roster.ts`
- `scripts/purge-extra-portal-accounts.mjs`
- `scripts/seed-akhil-dev-accounts.mjs`
- `scripts/wipe-dev-supabase.mjs`
- `scripts/wipe-test-db-all.mjs`

## Required applicant reader adaptation

At minimum: manager/resident list/detail API, anonymous token-bound application resume, own-resident autofill, setup-link routes, Checkr and Stripe screening/webhook paths, application/PDF/group export and lease-generation helpers. Preserve owner/role/property checks before decryption and return minimal projections to lists/tools. Keep IDs, access predicates, dates used for operational querying and attachment references in their current schema unless their complete consumers are migrated. Browser persistence removal is being handled separately; do not re-persist decoded identity.


## Applicant rollout, threat model and remaining copies

- Configure the shared server-only keyring before deployment. `tsx --conditions=react-server scripts/security/backfill-applicant-identities.ts` defaults to a read-only dry run; `--apply` is limited to declared dev/staging with verified TLS. It validates existing ciphertext, encrypts legacy fields, rotates keys, locks rows during apply and commits all changes together. It emits only counts and generic errors. No hosted applicant migration or production write was performed by this subtask.
- Resolve legacy unassigned owners before apply; the script cannot safely invent ownership. After successful apply and a zero-plaintext second dry run, enable `APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS=true`. Keep needed old keys until every current row has rotated. Old backups/WAL and historical SQL/seed data are not retroactively erased.
- This protects the canonical identity fields against a logical DB dump obtained without the application keyring. A DB writer cannot move an envelope to a different application or change its origin namespace without detection. It does not protect against a compromised application server/key store, an authorized recipient, screenshots/browser memory, or an attacker who can change authorization records and then invoke the trusted application. Those require independent authorization, auditing, retention and key isolation.
- **Separate remaining copies:** `portal_lease_pipeline_records.row_data.application` embeds rental forms; generated lease HTML/PDF may retain DOB. `existing-resident-onboarding.server.ts` can create that lease snapshot from a full application. Document encryption, historical attachment objects, arbitrary custom answers/free text, screening vendor reports and observability copies require their own boundaries. Do not claim that the entire database or all applicant PII is unreadable without keys solely because this canonical table slice is ready.
- Operational scripts and historical SQL can bypass the runtime codec. Re-seeding or applying old data-population SQL after cutover must run the identity backfill before strict readers are enabled. RLS is enabled on the applicant/co-signer tables with service-route access in their creation migrations; deployed grants/policies must still be verified during staging.
- Browser/native compatibility: no portal routes, navigation or UI schema changed. The WebView and browser receive the existing plain form shape only through authorized responses; application lists/resume use private,no-store. The root cache work removes persistent applicant storage and isolates viewer generations. No SSR/static-render request dependency or framework changes were introduced. Browser memory necessarily holds fields being edited/rendered; dedicated staging must exercise submit/resume, setup, owner transfer, PDF, autofill and provider screening.

## Local validation of the identity changes

Focused canonical applicant/co-signer tests cover encrypted storage and decode, row/owner tamper, exact case-sensitive PK bindings, strict legacy reads, backfill idempotence/rotation, client metadata rejection, omitted-field preservation, explicit clearing, owner transfer, public co-signer submission, resident victim-ID authorization, resume-token-before-key access, PDF inputs and screening owner checks. Existing token/setup/onboarding/draft/SMS consent/tool/PDF/clear-housing/Checkr regressions also ran. These tests use synthetic values and mock service boundaries; they are not a hosted DB migration, external vendor transaction or independent penetration test. TypeScript and focused ESLint results are reported in the parent run; no build/deploy claim is made here.


Backfill connection option: `SECURITY_DATABASE_CLI_LOGIN=1` uses the existing authenticated Supabase CLI to obtain short-lived development/staging PostgreSQL credentials privately, verifies client TLS, and sets the transaction-local postgres role. The target reference is derived from NEXT_PUBLIC_SUPABASE_URL and checked against the explicit nonproduction allowlist. The default remains the guarded static connection string. Neither mode logs credentials; neither automatically applies changes. Legacy apply remains a rollout step after compatible code is deployed.
