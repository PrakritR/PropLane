# Production control verification — 2026-09-05

Read-only inspection of Supabase production project `qahnczmilgptcedaqype` at **17:39 UTC**. This verifies the controls below at that time; it is not a penetration test or an external Trail of Bits audit.

## Confirmed controls and gaps

| Control | Observed production state |
| --- | --- |
| Database SSL enforcement | **Disabled**: CLI returned `currentConfig.database: false`, `appliedSuccessfully: true`. No update was requested. |
| Inspection connection | TLS encryption, certificate chain and hostname verification succeeded with the supplied public Supabase CA; `transaction_read_only` was `on`. |
| `profiles`, `profile_roles` | RLS enabled; one permissive SELECT policy each, scoped to PostgreSQL `public`. Both `anon` and `authenticated` lack table-level INSERT/UPDATE/DELETE grants, but retain SELECT, TRUNCATE, REFERENCES and TRIGGER. |
| `manager_application_records`, `cosigner_submission_records`, `manager_automation_settings` | RLS enabled; no policies. Both browser roles retain all seven checked table privileges: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER. |
| Application documents | `application-documents` bucket exists with `public: false`. |
| Manager documents | `manager-documents` bucket exists with `public: false`. |
| Application account MFA | **0 of 23** application accounts have a verified MFA factor. |
| Explicit-role application administrator MFA | **0 of 1** explicit-role admin account has a verified MFA factor. |

All five tables have `FORCE ROW LEVEL SECURITY` disabled. This does not disable RLS for ordinary browser roles; owner/bypass roles require separate application authorization.

**Next priorities:** enable production database SSL enforcement during an approved operational window after client compatibility checks; remove unnecessary browser table privileges through the normal migration and QA process; enroll and enforce administrator MFA. Supabase documents that SSL enforcement governs direct/pooler database connections, while its HTTP APIs already require SSL. Changing enforcement restarts the database. [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

RLS without policies defaults to denying ordinary row access, so the broad application-table grants alone do not prove exposed customer rows. However, PostgreSQL RLS does not govern TRUNCATE or REFERENCES: retaining these privileges is unnecessary exposure. No exploit or destructive operation was attempted, and reachability through an HTTP/RPC surface was not tested. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Method and exact limits

- Used Supabase CLI **2.116.0**: `ssl-enforcement get --project-ref qahnczmilgptcedaqype --output json --experimental`. This was GET only.
- Used CLI `db dump --project-ref qahnczmilgptcedaqype --data-only --schema public --dry-run --yes` solely to obtain the existing ephemeral CLI login. The generated dump command was **never executed**. CLI output and credentials stayed in process memory; no environment file or stored production password was read or printed.
- The initial connection without the additional CA failed before any SQL. The retry used the existing public CA, `rejectUnauthorized: true`, and verified the TLS stream. Executed `BEGIN READ ONLY`, `SET LOCAL ROLE postgres`, 15-second statement and 5-second lock timeouts; ended with `ROLLBACK` and disconnected.
- Fixed queries inspected catalog metadata and effective table grants only for the five named tables, policy command/role/count metadata, and the two named storage bucket flags. Policy expressions, column-level grants, grants on other tables/functions, storage object policies and signed-URL behavior were not inspected. RLS enablement is not proof of complete tenant isolation.
- MFA queries returned only aggregate counts. IDs were joined inside SQL and never returned. Admin scope was the union of `profile_roles.role = 'admin'` and case-normalized `profiles.role = 'admin'`. The application's primary-admin email fallback was excluded to avoid retrieving email values. Enrollment counts do not establish challenge enforcement or session assurance. The source search found no `mfa`, `aal2` or `AuthenticatorAssuranceLevel` references in `src/lib`, `src/app/api` or `src/middleware.ts`; this is bounded source evidence, not a provider configuration check.
- **Supabase/Vercel/GitHub organization or provider-account MFA was not inspected.** Application MFA is a separate control. No customer content, account identifiers, email addresses, documents, application records or object contents were retrieved. No SQL writes, migrations, backfills, configuration changes or production deployment occurred.

Reproduction script: `/private/tmp/proplane-production-controls.mjs`. Sanitized metadata/count evidence: `/private/tmp/proplane-security-scan/production-controls.json`. These temporary artifacts contain no credentials or customer content; the production snapshot is summarized above so this report remains useful without them.

## Prepared least-privilege correction

`supabase/migrations/20260906040000_sensitive_table_browser_privileges.sql` removes TRUNCATE/REFERENCES/TRIGGER from `profiles` and `profile_roles`, and all browser table privileges from the three server-only tables, for `anon`, `authenticated` and PostgreSQL `PUBLIC`. It preserves existing SELECT policies on the two profile tables and service-role privileges. This report does **not** assert that this migration has reached production.

The bounded call-site review found 86 source modules querying the three server-only tables, none with a browser-client factory or client directive. The 17 API modules that also instantiate a session client use separate service clients for these table operations; browser application/co-signer stores use API transport. Shared automation settings helpers take injected database clients and frontend settings use route transport. No intended direct browser access was found; the observed production default-deny policies already prevented ordinary browser row access. Migration-order regression checks include platform defaults, later regrants, and PUBLIC inheritance: **23 tests passed**, changed test file ESLint **0 warnings**. Hosted application of this correction remains a separate operation.

## Authorized rollout update — 23:02 UTC

The user authorized production encryption rollout and access hardening. Production SSL enforcement was enabled through the fixed-project CLI command; a fresh GET returned `currentConfig.database: true` and `appliedSuccessfully: true`. After the restart, a new certificate/hostname-verified direct database inspection completed successfully, and a bounded HTTPS database request returned 200 with zero rows (`limit=0`).

A separate random 32-byte production application key (`production-20260905`) and active key ID were provisioned as sensitive Production-only Vercel settings. A macOS Keychain recovery copy was read back and compared privately; the local operator file is gitignored and mode 0600. This is local recovery verification, not independent organizational key management. The public database CA was provisioned in Production settings. These environment updates affect future deployments; application encryption is not yet live.

The original inspection above is historical evidence. Production privilege migration, application backfills, strict enforcement and administrator MFA remain pending.

### Production schema applied

The five fixed security migrations applied transactionally after their source hashes, prerequisites and migration history were verified. Post-apply checks passed for all five exact history entries, RLS/browser privilege boundaries, service-only RPC bodies/owners/search paths, document bucket configuration and alias key/foreign-key constraints. Existing profile row grants were preserved. The first attempt rolled back because the verifier received PostgreSQL `name[]` as a string; casting catalog column names to `text` fixed the verifier without changing migration SQL. A read-only staging inspection confirmed all five boundaries before the successful production retry. No applicant, co-signer, calendar or document backfill has run in production.
