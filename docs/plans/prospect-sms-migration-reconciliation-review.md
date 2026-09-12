# Independent migration reconciliation review

2026-09-12. Pool5 keeper `prospect-sms-release`, baseline `48401d4a18af183b1de51abb3119a2e50dd1a5b9`. This reviewer is reused under the root's explicit four-thread capacity fallback. Review is read-only against source, private before-ledgers, public-schema dumps, and captured bucket/policy metadata. No remote mutation, message send, model call, or release was performed.

## Findings and disposition

The first schema comparison found a real gap in the production `shared_room_capacity` lineage: `normalize_application_record_id` omitted `occupancy_start` from the replacement row. Certifying the complete canonical migration without correcting that function would have been false. The new `20260912150000_shared_room_capacity_normalization_occupancy_start.sql` addresses precisely this gap. Its function and ACL equal the authoritative block in `20260906070000_shared_room_capacity.sql` after removing comments and normalizing whitespace. Applying it executes function/ACL DDL only; it does not call the function or rewrite application/listing rows. SHA-256: `78a25930905b34d16348f7f5d28023a184a89ae0bf5a08d2f673de0048484f28`.

The historical `20260716090000_agent_pending_actions.sql` rename to `20260716090000_agent_pending_actions_portal_columns.sql` preserves its SQL bytes and version. Target-specific duplicate handling, locked live-ledger comparison, and removal of private `/tmp` fixture dependencies from committed unit tests were requested during draft review and are present in the reviewed revisions.

## Attestation for 21 production mirror identities

Fifteen identities have every canonical statement matched to split statements in the captured production ledger after comment/whitespace normalization: `portal_inbox_attachments_bucket`, `manager_sms_contact_email`, `manager_sms_agent_sessions`, `work_order_events`, `manager_assistant_emails_mailbox_local`, `action_event_bus`, `account_link_invites_expiry`, `work_order_vendor_offers_declined`, `manager_comms_billing`, `manager_voice_agent_sessions`, `manager_comms_usage_invoicing`, `comms_usage_work_number_setup`, `action_event_cross_party_domains`, `account_link_open_invite_token`, and `statement_match_targets`.

The mailbox-local statements occur in `20260906211554_manager_assistant_emails`. The attachments bucket repair also matches; fresh captured metadata confirms private access, 10 MB, JPEG/PNG/WebP/GIF/PDF, and no storage policy exposing this bucket.

The remaining six identities were reviewed as follows:

- `co_manager_permissions_explicit_grant`: recorded bundle DO body has identical executable logic after comment/whitespace normalization. Its single comment literal equals the canonical concatenated comment. Do not replay this historical grant backfill against today's intentionally empty permissions.
- `reminder_queue_expand_kinds` and `reminder_queue_payment_manager_kind`: the production final constraint preserves all twelve earlier kinds and adds `inspection`/`inspection_manager`; role check is `manager`, `counterparty`, `team`. This is the expected later inspection migration supersession.
- `sales_migration_provenance` and `utility_allocations`: bundle SQL differs by `IF NOT EXISTS` only. Actual catalog columns, defaults, checks, primary/unique keys, foreign keys, sales index, RLS, owner SELECT policies, and authenticated SELECT-only/service-role ACLs match the canonical contracts.
- `shared_room_capacity`: the other five apparent function differences are comments only; compared function bodies match. The normalization function requires the new correction above, with its definition and ACL verified after apply.

No unexplained remaining contract mismatch was found among these 21 identities once the occupancy correction is applied and attested. Historical bundle records must remain intact; guarded canonical identity mirrors must not replay their SQL.

## Scope boundaries

The production DDL batch is the reviewed SMS migration plus the narrow occupancy correction. The three older upstream migrations missing from staging belong only in staging's batch. In particular, `portal_workspaces` has broad property backfill DML and must not be replayed on production's already-applied version. The separate locked-live-listing rule remains intact.

Ledger reconciliation is not a claim that both databases have identical schemas. Independent comparison found pre-existing, already-ledgered differences outside these 21 mappings: production `profiles.phone` is numeric versus staging text, and production `vendor_tax_profiles` has primary key `vendor_id` versus staging's composite manager/vendor key. These are disclosed separately and not silently changed or certified away. Production's extra PUBLIC revoke on `allocate_sms_proxy_number` is stricter; agent table differences are column order only.

Burst activation and GPT comparison remain disabled. The SMS migration SHA-256 remains `d1581654a9dbff50c70d96f073de3c8cfca8c13416997dae2b1d64b4161f79ab`, with root's separately reported 97 isolated PostgreSQL assertions. The policy replacement follows Akhil's explicit instruction, preserves bounded authorization and backups, and does not remove the live-listing lock or weaken the strict parity checker.

## Final reviewed gate

Approved for the bounded, explicitly authorized staging-first DDL and ledger reconciliation. No remaining blocker was found in the reviewed mapping or apply runner. This approves the concrete operation; it does not claim remote execution, deployment, or burst activation has occurred.

Reviewed runner SHA-256: `9357dcfb9e660c1ccef0a7626b72561c8aaebe99fd255533e85f25a9335e3c1f`. The final runner pins the independent attestation and all four evidence files, validates the correction source hash and prerequisite, verifies all lineage statement hashes against the locked live ledger, checks exact normalized live function body and service-only ACL, preserves bundle records, refuses unexpected identities/additions, and rolls back the transaction on mismatch. The initial PUBLIC pseudo-role query, source-path mismatch, substring-only function test, missing correction hash guard, and spacing-sensitive statement-match lineage refusal are corrected.

Independent read-only execution against both private captured ledgers exited 0: staging selects two renames/five pending DDL identities, production selects one rename/two pending DDL identities and all 21 mirrors. This reviewer also ran `git diff --check`, exit 0.

Implementation reports final focused unit/parity tests 51 passed and ESLint exit 0. Root ran the actual disposable PostgreSQL shared-room suite: 12/12 passed, exit 0, with the corrective function loaded. Root's actual ledger rehearsal exited 0: staging two renames/no mirrors/199 rows; production one rename/21 mirrors/209 rows. Both injected failures after a real UPDATE rolled back the entire transaction before a successful retry established unique identities. This reviewer read the result JSON; it did not rerun root's database commands. Evidence: `/tmp/prospect-sms-reconcile/shared-room-test.log`, `ledger-rehearsal-result.json`, and `rehearse-ledger.mjs`.

Pinned sanitized independent attestation: `/tmp/prospect-sms-reconcile/production-catalog-attestation.json`, SHA-256 `269baaaaa584d1d49f2ba5e7e288b556ce11f65e9654994df17114e67d026036`. Root retains responsibility for exact target binding, private backups, controlled Supabase CLI DDL batches, post-apply catalog/parity verification, and release/deployment checks. Keep the production workspace backfill excluded and preserve the separate locked-listing rule.

### Final guard tightening acknowledgment

After the approved checkpoint, the runner's schema-attestation field check was tightened from a 64-hex format check to equality with the existing pinned schema hash, and the evidence map now requires exactly four distinct entries. Independent inspection confirms this is the entire subsequent runner diff and only narrows acceptance. Approval is maintained for runner SHA-256 `a55e563534e3e27eeba74c782127ae6bf5d5b550071ebfc21137ef547ffb94ee`; root is rerunning focused tests and the real PostgreSQL rehearsal on this hash before apply. Earlier validation results above belong to the earlier checkpoint and are not relabeled as rerun evidence.
