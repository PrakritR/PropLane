# PRP-448/449 dev database validation

Target: dev/test `emstjswhotsnyksqhqyf` only. Migration `20260909100000_atomic_lease_action_events.sql` applied with the repository `db:push` command using Supabase CLI 2.117.0.

The isolated migration work directory used the existing remote history. Dry run listed exactly this one additive migration, with no seeds or roles; apply exited 0. No historical migrations were replayed and no production or staging project was modified.

The rollback-only SQL harness used existing seeded manager/resident identities and a unique temporary lease id. It passed atomic lease rollback on malformed notification, durable pending manager projection, monotonic CAS timestamps, stale-write rejection, replay deduplication, wrong-recipient rollback, and anon/authenticated RPC execution denial. It performs no external notification. The harness exited 0 and rolled its fixture transaction back.

Provider SMS/email and the real two-party signing browser flow remain separate acceptance checks. A successful SQL transaction does not prove either channel reached its recipient.

The follow-up migration `20260909110000_action_event_sms_deferred_until.sql` also applied to dev/test only. Its dry run listed exactly one migration; apply exited 0. A read-only schema query confirmed `sms_deferred_until` is `timestamp with time zone`. This explicit field retains SMS timing independently of retry errors and channel outcomes. The earlier rollback-fixture cleanup query confirmed zero remaining temporary lease or event rows.
