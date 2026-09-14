# PRP-472 independent dev RPC validation

Root Astra validation on September 13, 2026, during initial Sol execution. Keeper `akhil/prp-472-inbox-unread`, integration HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`, feature changes uncommitted. This report verifies the new database operation, not final route/UI acceptance or a release.

## Reviewed and applied source

Migration: `supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql`.

SHA-256 independently read and verified before apply: `8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6`.

Root reviewed the SQL against the safety addendum: one conditional metadata-only update with exact JSONB/timestamp/identity preconditions, manager scope restriction, explicit valid folder and JSON boolean predicates, monotonic timestamp, invoker/volatile function with empty search path, and transactional restricted grants. Sol subsequently reported the exact-one-file dev-only dry run and apply both exited 0, with no seeds or roles. Sol owns the apply ledger and private migration-workdir cleanup.

## Live catalog check

Command, from pool6 with the existing dev link:

```text
npx --yes supabase@2.117.0 db query --linked --project-ref emstjswhotsnyksqhqyf "select p.proname, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute, has_table_privilege('service_role', 'public.portal_inbox_thread_records', 'UPDATE') as service_update from pg_proc p where p.oid = 'public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb)'::regprocedure"
```

Exit 0. Actual catalog values: `prosecdef=false`, `provolatile=v`, `search_path=""`, `anon_execute=false`, `authenticated_execute=false`, `service_execute=true`, `service_update=true`.

## Real request and concurrency probes

Command:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node /private/tmp/axis-inbox-cycle/prp472-rpc-probes.mjs
```

Exit 0. Sanitized results: `/private/tmp/axis-inbox-cycle/prp472-rpc-results.json`. The private harness asserts the exact dev/test hostname before creating clients or mutating rows. It uses ordinary authenticated and anonymous PostgREST requests for execution-denial checks and the service client for isolated state setup and RPC checks. No credentials or message payloads were printed.

| Probe | Observed result |
| --- | --- |
| Real anonymous and authenticated RPC calls with complete row preconditions | Both denied with PostgreSQL `42501`; unread unchanged |
| Exact snapshot acknowledgement, histories of 2, 50 and 150 messages | `true`; only `row_data.unread` changed; timestamp advanced; repeat stale call returned `false` |
| Long histories | POST bodies of 22,125 and 65,377 bytes succeeded for 50 and 150 messages |
| Appended message with unchanged timestamp before CAS | Stale acknowledgement returned `false`; new body and unread preserved |
| Concurrent draft and archive edits with unchanged timestamp before CAS | Both stale acknowledgements returned `false`; edited row JSON preserved exactly |
| Ten invalid identity/precondition variations | All returned `false`, including empty ID, null/wrong owner, wrong scope/participant/type, null/wrong timestamp, null/non-object expected JSON |
| JSON string `"true"`, malformed unread string, trash, and missing folder | No-op without error; row JSON unchanged |
| Three concurrent append and old-snapshot RPC request pairs | RPC results `false`, `true`, `true`; in every ordering, final row retained the newly appended message and `unread:true` |
| Cleanup | Exactly 15 inserted probe records deleted with exact ID, owner and scope filters |

Probe IDs were unique `prp472-rpc-probe-<run>-<case>` values. To avoid transient records in the manager's browser QA inbox, they used the canonical resident test user's ID as owner in manager scope. This tests the service-only database function's identity preconditions; it does not assert that the resident has manager route access. The authenticated RPC denial used that ordinary dev/test resident account, including a matching owner ID. No user roles were changed. Root's existing manager inbox/SMS fixtures were untouched.

The deterministic same-timestamp mutation tests model an intervening write between server observation and CAS. The three concurrent requests additionally exercised both winning orders, as shown by their true/false results. This is not a claim that generic message writers became transactional or that the route's multi-source action is a batch-wide transaction.

No production or staging database action, provider send, account deletion, migration-history repair, or unrelated migration apply occurred. Final UI, route permissions, broad checks, and fresh Astra/security/Bugbot review remain separate gates.
