# Account deletion and recovery handoff

Updated 2026-09-07. Implementation is ready for main review and staging QA;
**production has not been changed**. Prakrit's ownership manifest remains the spine,
including the newer orphan-cleanup implementation with its financial deletion bug fixed.

## Implemented

- Portal deletion privately retains eligible records and files for 30 days. Setup,
  password registration, OAuth and provisioning intercept pending recovery before
  granting the deleted portal again. Password reset remains available.
- Authenticated users verify their mailbox with a 15-minute challenge, then choose
  Recover or explicitly confirm Start fresh. Opening the link changes nothing.
  Start fresh erases the retained personal data immediately; expiry denies recovery
  at the original deadline and queues permanent cleanup.
- Resident deletion detaches UUID, email and legacy JSON access keys from a surviving
  manager's financial/lease history. Recovery conditionally restores identity only,
  preserving intervening financial edits and reassignment. Manager removal of a
  resident is property-scoped; global resident deletion is admin-only.
- Canonical shared records respect every owner's current choice. Independently owned
  vendor financial records preserve the surviving business party. Portal archives
  already pending for the same login remain independent on final-portal deletion.
- Multi-role accounts retain their other roles. A full fresh start deletes the empty
  Auth shell, creating a new UUID on signup. Re-created self-keyed settings receive
  a new generation; old settings and credentials are never replayed.
- File copies use a private bucket and immutable generations; original keys are
  retired, normal authorized reads resolve recovered bytes, and shared live file
  references remain available during another owner's re-deletion. Encrypted reads
  retain the original logical path for authentication/decryption context.
- Durable archival/purge intent, retry backoff, standalone file-deletion retries and
  rotating retired-file cleanup support interruption. Terminal compaction removes
  completed request identity and redundant snapshots once no shared recovery needs them.
- Full browser navigation follows cache cleanup. Named outcome analytics contain
  identifiers/enums only, with no recovery tokens or personal data.

## Validation and database state

- Full unit suite: **1,317 files / 9,044 tests passed**.
- Regression coverage includes financial preservation and reassignment, shared
  recovery ordering, nullable FK cycles, token validation, private-file generations,
  settings re-creation, terminal compaction, StrictMode and explicit confirmation.
- TypeScript passed. Changed-file ESLint has no errors (three existing unused-symbol
  warnings). Local build validation is blocked: Turbopack rejects the worktree
  node_modules symlink; webpack exceeded the default Node heap. CI/staging must
  provide a successful production build before promotion.
- PostgreSQL 17 concurrent-lock smoke passed: a conflicting writer returns retryable
  40001 instead of deadlocking a lifecycle transition.
- All eleven account-deletion/recovery migrations are applied and registered on
  **dev only**, project `emstjswhotsnyksqhqyf`. A rollback-only test against its actual
  schema passed deletion, verified profile recovery and terminal identity cleanup.
- No production migration, production deploy or existing-production orphan purge ran.

## Staging acceptance before production

Apply these migrations in order to staging, then test real mailbox links, Supabase
Storage copies/downloads, encrypted documents, both-party and multi-portal choice
orders, interrupted cleanup, stale sessions, and desktop/native WebView flows.
The authenticated `/api/cron/account-deletions` endpoint requires `CRON_SECRET`;
Vercel schedules it daily. Recovery is denied at 30 days; physical expiry cleanup
runs at the next successful scheduled pass. Preview cron execution needs an explicit
QA invocation. Configure Resend and the canonical email-link origin for the environment.

External provider records, provider logs/backups, PostHog and Langfuse retention are
not erased by this application database/Storage lifecycle. Existing production
orphans also need a separately scoped audit of their original UUIDs; deleting by
reused email alone could destroy the new account's records. These are release/data
operations considerations, not evidence that all external copies have been erased.

## Manager and resident ownership

| Situation | Required result |
| --- | --- |
| Resident deletes their portal | Retain the surviving manager's charges, payments, deposits, payment plans, journal lines, leases and accounting evidence. Do not change amounts, statuses or balances. Remove the resident's access and automatic email/UUID association. Archive/delete the resident's personal account data on the agreed schedule. |
| Resident recovers | Restore their eligible records and conditional tenancy links; never replay an old financial snapshot over manager edits. Do not reinstate a link the manager has reassigned or revoked. |
| Resident starts fresh or expires | Destroy their recoverable personal copy and recovery links. Keep the manager's books. A reused email must not expose those old records to the fresh account. |
| Manager deletes their portal | Archive that manager's workspace, unpublish its listings, stop jobs/integrations and remove delegated access. Preserve residents' logins, independently owned records and relationships with other managers. Show the removed tenancy as unavailable; do not delete residents globally. |
| Manager recovers | Restore eligible workspace data; re-enable integrations, billing, automation and delegated access only through their normal setup/approval flows. Respect resident deletions that happened since the snapshot. |
| Manager removes a resident from one property | Revoke only the authorized tenancy/property relationship. This must never become global resident account deletion. Preserve its accounting history. |
| Both delete, in either order | A recovery snapshot must not override the other person's deletion, expiry, fresh start or later recovery. Shared data must follow its actual owners' current decisions, not whichever archive restores last. |

Financial history is an explicit exception to personal-data erasure: the surviving
manager retains their business records. Removing a login does not forgive a balance.
The precise treatment of resident-owned copies of documents must be encoded per
record, separate from the manager's original and from private applicant documents.

## Coverage inventory

Continue using `src/lib/auth/account-purge-manifest.ts` and its schema coverage test
as the single ownership catalog. Extend its policies rather than introducing an
independent list of deletion statements.

| Area | Required handling |
| --- | --- |
| Auth, profile, roles, verification, sessions | Separate login identity from portal membership; reconcile legacy primary roles and role rows consistently. Invalidate old sessions and prevent deleted-role regrant through signup, OAuth, setup links or stale JWTs. |
| Properties, applications, screening, cosigners | Follow both physical foreign keys and legacy application identifiers. Classify private applicant data versus shared business evidence; include encrypted-document alias mappings. |
| Leases, charges, ledger, deposits, journals, bills, statements, distributions | Explicit ownership and retention. Resident deletion detaches access instead of deleting the surviving manager's financial rows. Restore relationships without overwriting updated financial values. |
| Maintenance, inspections, vendor records, invoices, payouts | Preserve the independently owned side. Never delete another manager's/vendor's records merely because an identity appears as a reference. |
| Inbox, support, messages, schedules, notifications | Portal-scope personal history; retain shared support records. Stop queued sends and protect recipient references. Never replay old scheduled actions on recovery. |
| AI conversations, pending actions, audit records | Scope histories by portal, invalidate pending approvals, retain permitted shared audit history with valid nullable actor references. Do not restore permissions from old previews or trace ids. |
| Co-managers, invites, API/MCP credentials, calendar, work numbers | Revoke delegated access and credentials. Resolve provider cancellation/release before losing retry identifiers. Recovery requires reconnection/reapproval. |
| Browser and native caches | Clear persistent caches and use full document navigation. Test module memory, in-flight sync, other tabs, account switching and the native WebView. Server-side guards must prevent stale writes regardless of local cleanup. |
| Storage | Inventory `application-documents`, `manager-documents`, `listing-photos`, `lease-templates`, `vendor-documents`, `portal-inbox-attachments`, `bug-feedback-attachments`, `sms-media`, `inspection-evidence`. Paginate every discovery. Use reference-aware ownership for shared files and encrypted aliases. |
| Providers and observability | Stripe, Twilio, PostHog, Langfuse traces/eval datasets, provider payload logs and backups require explicit retention/deletion handling; application-table deletion is not proof these copies were erased. Never send recovery tokens or PII as analytics properties. |
| Existing production orphans | Separate remediation: identify original UUID and exact surviving data first. Do not delete a new account's records just because its email matches an old account. |

