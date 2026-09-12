# Prospect SMS migration reconciliation handoff

This handoff authorizes no remote action. Root owns the database, CLI, release, and promotion steps.

The pre-reconciliation ledgers are pinned: staging `fbdc8f235d6846b592434092ad3b08751d2eeb6cb025c699845c4e99a6c99b93`; production `e64295431a7384a57f7423bba81376bc9319e9e36ca94f88e5d690ea507e5817`. Production also pins schema evidence `8ae45fcd16f3782e1897d20a3c1c8a5098f398f36bb9c587570d9649f4e07c6c`, bucket evidence `f102777850202483e57e08f8c24059edcc58334b922fc1d99b271576ec0b8635`, storage-policy evidence `a02d226c36da62e4dc8d68e623c97df47c39f5ad7ec648d1353b16a08a1c59c5`, and the reviewed catalog attestation `269baaaaa584d1d49f2ba5e7e288b556ce11f65e9654994df17114e67d026036`. Keep these private files under `/tmp/prospect-sms-reconcile/`.

Rename `20260716090000_agent_pending_actions.sql` to `20260716090000_agent_pending_actions_portal_columns.sql` without changing SQL or version. Repair that exact historical identity on both targets. Staging also repairs only `20260907073044 resident_invite_links` to `resident_invite_links_legacy_20260907073044`.

Apply DDL through the normal temporary Supabase CLI process. Staging gets, in order: `20260911190000_sms_conversation_houses`, `20260911230000_portal_workspaces`, `20260912000000_vendor_business_profiles`, `20260912143000_prospect_sms_bursts`, and `20260912150000_shared_room_capacity_normalization_occupancy_start`. Production gets only the last two. Never replay production's canonical three upstream migrations. The shared-room correction is function-only and has no listing/application DML.

Create a fresh read-only post-DDL ledger capture. It may differ from baseline only by the target's listed DDL identities with exact normalized source statements. The runner checks that rule again after beginning and locking `supabase_migrations.schema_migrations`.

Run staging only after its dry-run, catalog verification, and QA. Import
`executeGuardedLedgerRenames` into the private root execution helper and pass
the verified database connection string in process memory. Do not put a
database credential in a shell argument or log. Supply the fresh post-DDL
ledger as `expectedLedger`; the helper must first run the exported baseline and
reviewed-DDL checks against the pinned staging capture.

The production catalog attestation contains all 21 source hashes, exact bundle-statement hashes, schema/ledger/bucket/policy evidence hashes, and the occupancy prerequisite. The correction source is pinned to `78a25930905b34d16348f7f5d28023a184a89ae0bf5a08d2f673de0048484f28`; its exact identity, function signature, security-definer, empty search-path, and ACL prerequisite are checked before its body is extracted. The runner reads and hashes the exact attestation plus all four referenced evidence files itself, checks every lineage record against the locked ledger, preserves all bundle rows, inserts only absent canonical version/name pairs with exact local SQL, and compares live `normalize_application_record_id` `prosrc` byte-normalized body exactly with the corrective migration while checking security-definer, search-path, and ACL. It rolls back on a mismatch.

After staging and fresh production catalog review, use the same in-process
helper for production. Pass the parsed pinned catalog attestation and fresh
post-DDL ledger directly to `executeGuardedLedgerRenames`; keep the verified
connection string in memory. The exported function independently rebinds the
target, opens and locks the transaction, verifies lineage and live function
state, performs the one rename plus 21 mirrors, and rechecks identity
uniqueness before commit.

The 21 mirror records retain all original bundle records. Fourteen have exact normalized statement lineage. The remaining seven are attestation-certified: co-manager permissions (COMMENT representation only), two reminder constraints, sales provenance, utility allocations, shared-room capacity, and `statement_match_targets`, whose individually attested statements are interleaved with bundle idempotency DDL. `manager_assistant_emails_mailbox_local` maps to exact `20260906211554_manager_assistant_emails` lineage. Do not replay co-manager or expiry backfills.

Validation completed: `vitest` over the three focused migration files passed 54 tests; scoped ESLint and `git diff --check` exited 0. The shared-room PostgreSQL integration test ran against a disposable local PostgreSQL 17 database and passed all 12 tests. A second isolated PostgreSQL rehearsal executed both ledger transactions: staging completed two renames and no mirrors; production completed one rename and 21 mirrors. Injected failures after a real update rolled both transactions back before successful repeat runs proved unique names and all expected mirrors. Evidence is `/tmp/prospect-sms-reconcile/ledger-rehearsal-result.json`. Graph refresh was not run because this worktree's installed Graphify package has no executable, a known root-confirmed limitation.
