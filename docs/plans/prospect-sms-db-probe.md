# Independent SMS database probe

Date: 2026-09-12. Root Astra investigation during implementation.

An isolated PostgreSQL instance was initialized with trust authentication bound to localhost and minimal `auth.users`, `sms_outbox`, and client/service roles. No shared database or external messaging service was used.

Migration: `supabase/migrations/20260912143000_prospect_sms_bursts.sql`

Tested SHA-256: `7bedf415b53d67afe7afba6f3a79439ca00cc4bdef3da21cc3ef9ac7cc1ccd40`

## Results

- `initdb` and `pg_ctl start`: exit 0.
- `psql -h 127.0.0.1 -p 52387 -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260912143000_prospect_sms_bursts.sql`: exit 0 on initial apply and repeat apply.
- Python subprocess harness invoked the real SQL functions through independent psql connections, including simultaneous competing claims: exit 0, 16 assertions passed.

- same source SID is idempotent.
- duplicate SID does not extend quiet window.
- Twilio and Claw converge to one SMS conversation.
- new inbound resets quiet window to 20s.
- two simultaneous workers yield exactly one claim.
- claim contains both unhandled inbound messages.
- new input preserves active worker lease.
- stale worker cannot complete.
- second worker cannot overlap live lease.
- expired worker lease can be reclaimed.
- reclaimed turn includes all unhandled texts.
- current worker completes exactly once.
- later burst excludes previously handled messages.
- anon cannot execute service mutation.
- authenticated cannot execute service mutation.
- client roles cannot select transcript table.

## Limits

This verifies the tested migration only. Callback retry behavior, actual Twilio submission, QStash signatures, model semantics, and integration with the existing outbox require separate tests. Later migration edits require revalidation. Stubs do not establish complete Supabase schema compatibility. Local output remains at `/var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-sms-pg-enkx6hr2/probe-results.json`.

## Integrated dispatch checkpoint

The next clean schema run caught an undeclared variable in the inline-action function (psql exit 3). The implementation manager corrected it. An intermediate reapply also encountered the changed OUT signature of a prior, undeployed WIP function; the final probe rebuilt the isolated schema from scratch.

Final tested snapshot SHA-256: `fbea75bc4885ce2681b2ad430228b7f9c2e2d0eafe3ad19718fa1cd7143ec147`.

Clean transactional migration apply and identical repeat apply: **exit 0** each.

`python3 /var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-sms-pg-enkx6hr2/probe-final.py`: **exit 0, 35 assertions passed**. The exact tested migration, prerequisite stubs, runnable probe, and JSON results are retained together in that temporary directory.

- quiet window is 20 seconds.
- duplicate source preserves revision and due time.
- both SMS transports share one burst.
- different counterparty is isolated.
- different owner is isolated.
- concurrent claims have one winner.
- snapshot contains only the burst sources.
- inbound preserves generation lease.
- no second active generation.
- stale completion rejected.
- stale worker promptly releases own lease.
- failed turn remains retryable.
- failed turn does not consume inputs.
- first inline action authorized.
- retry with different model call ID cannot duplicate action.
- prepare reply under live generation lease.
- prepared context is not confirmed history.
- budget deferral leaves reply prepared.
- prepared reply submits once despite expired generation lease.
- campaign budget spent once.
- context promoted only at submitting boundary.
- submission advances handled watermark.
- unknown provider outcome is not automatically resubmitted.
- new burst excludes already submitted inputs.
- prepare reply under live generation lease.
- new inbound fences prepared old reply.
- stale reply spends no budget.
- stale outbox is blocked.
- stale inline write cannot execute.
- anon cannot execute queue mutation.
- anon cannot execute submission mutation.
- anon cannot read transcript.
- authenticated cannot execute queue mutation.
- authenticated cannot execute submission mutation.
- authenticated cannot read transcript.

These checks model dispatch transitions in SQL; they do not claim live Twilio delivery or QStash execution. `spend_sms_segment_budget` was loaded from the repository's actual control-plane migration. Context promotion and inline-action assertions apply only to this migration checkpoint; API/runtime behavior requires separate coverage.

## Inline-action retry checkpoint

Tested snapshot SHA-256: `203ba8203741f921a559223a1db3a1e4ca6412178c73451b4fcf2e710790754d`. Clean transactional apply and repeat: exit 0 each. The same retained `probe-final.py` now includes eight additional action-release assertions: empty call rejected, valid call accepted, wrong/stale workers cannot release, current worker can release a known pre-side-effect claim, corrected call can acquire, and anon/authenticated cannot release.

Final probe: **exit 0, 43 assertions passed**. Runtime must independently establish that a handler caused no side effects before calling the release RPC; these SQL tests verify claim ownership and revision enforcement, not that semantic classification.

## Durable shadow checkpoint

Tested snapshot SHA-256: `587d23a9770826c35a05f8cd6d3f3fdcabb2b92aec30b1b4ff8399914b09d710`. Clean transactional apply and identical repeat: **exit 0** each. `probe-final.py`: **exit 0, 52 assertions passed**.

The nine added checks establish that preparation creates no shadow job; concurrent submission creates exactly one frozen-input job; a new inbound preserves the already dispatched job; stale submission creates no extra job; and anon/authenticated roles can neither read nor update shadow transcripts. This does not establish runtime shadow-worker lease recovery or model quality; those require separate tests.

The isolated PostgreSQL server was stopped with `pg_ctl ... stop` (exit 0) after validation. Probe scripts, prerequisite fixtures, exact migration snapshot, and JSON results remain in the cited temporary directory for re-execution. No shared database was changed by these probes.

## Review finding: outbox preparation race

Security review identified an interleaving not covered by the first 52 assertions. The isolated server was restarted at `127.0.0.1:52387` and a generation was claimed. An outbox row representing a concurrent cron claim was inserted before preparation. Real SQL calls on the same tested migration returned:

```text
begin_sms_outbox_submission before preparation: stale
prepare_prospect_sms_outbox afterward: true
resulting burst/outbox statuses: prepared/blocked
```

Reproduction command exited 0. This confirms stranded work despite the initial passing probes and requires correction plus regression coverage. No external provider or shared database was called.

## Correction cycle 1: atomic preparation and real baseline schema

Final tested snapshot SHA-256: `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`. The isolated prerequisites now use the actual `sms_outbox` and `sms_delivery_attempts` DDL from `20260825120000_sms_control_plane.sql`, including constraints and text `property_id`, plus the actual segment-budget function. Other prerequisites remain minimal fixtures; this still is not full deployed Supabase schema validation.

An intermediate invocation exposed an OUT-parameter/table-column ambiguity in the new preparation RPC. That was corrected, and the RPC's property ID parameter was aligned with the text schema. Preparation and submission now take burst/outbox locks in the same order.

Final commands: clean prerequisite apply, transactional feature migration apply, and identical repeat apply each **exit 0**. `probe-final.py` **exit 0, 52 assertions passed** with atomic preparation. `probe-correction.py` **exit 0, 26 additional assertions passed**, for **78 real SQL assertions** on the final snapshot.

Additional coverage:

- Other connections see no claimable outbox while atomic preparation is uncommitted.
- Transaction rollback leaves the burst generating with no orphan intent; an expired-lease replacement worker can prepare one sendable intent.
- The canonical non-UUID property ID is retained under the actual baseline schema.
- Concurrent preparation yields one intent and one deduplicated return; no prepared/blocked orphan.
- A constraint error rolls back both preparation writes, and a valid retry succeeds.
- New ingress before preparation rejects the stale candidate without creating an intent.
- Claw ingress retains its rail/shared catalog; latest mixed ingress deterministically restores Twilio/owner scope.
- Preparation rejects mismatched manager, recipient, or transport; anon/authenticated cannot call it.
- Concurrent preparation and submission complete without a deadlock.
- Submitted and unknown intents cannot be revived by preparation retry, and remain one unique intent.

The runnable scripts, baseline fixtures, exact snapshot, and both JSON result files remain in `/var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-sms-pg-enkx6hr2`. No real provider calls or shared database writes occurred. These assertions complement runtime handler/dispatch tests; they do not prove a live gateway/Twilio integration.

## Final transport scope

The reviewed retirement amendment (`prospect-sms-retired-transport-amendment.md`) keeps Claw disabled. Correction cycle 2 leaves the proven SQL unchanged but rejects retired-rail ingress before durable acceptance and blocks any persisted retired-rail outbox at runtime without provider calls or sender fallback. The SQL rail/identity assertions above test compatibility metadata and validation only; they are not evidence that Claw delivery is supported or enabled.

## Release integration against current billing schema

Root independently validated integrated migration SHA-256 `d1581654a9dbff50c70d96f073de3c8cfca8c13416997dae2b1d64b4161f79ab` in the isolated localhost PostgreSQL instance (127.0.0.1:52387). The production/staging databases were not written. Fixture prerequisites use the actual original outbox/attempt DDL plus current 20260909090000 conversation-log columns, 20260910190000 campaign budget migration, 20260905130000 billing tables, and full 20260910140000 wallet/credit functions. Profiles are minimal fixture IDs/created_at; payment automation DDL is the actual dependency migration.

Clean prerequisite apply exit0; clean feature migration apply exit0; repeat feature migration apply exit0. Existing52 +26 assertions pass with the updated server allowance/unit/sender RPC signature. Additional19 assertions passed using the real wallet functions: exhausted-wallet rollback; storage-failure rollback and retry; campaign exhaustion rolls back the attempted credit reservation; same-outbox recovery; one credit event and one campaign debit; canonical owner/quantity; actual sender snapshot; duplicate/unknown non-revival; stale inbound fences both financial reservations; client-role denial. Total97 assertions, all three Python probe commands exit0.

Evidence directory: `/var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-sms-pg-enkx6hr2/release/`. Files: prerequisites.sql, migration-tested.sql, migration-clean.log, migration-repeat.log, probe-final.py/results/log, probe-correction.py/results/log, probe-credit.py/results/log.

The atomic submission RPC now has signature `begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer,integer,integer,text)`. The last four arguments are server-resolved plan allowance, legacy allowance, SMS unit cents, and provider sender. Owner, quantity, and reservation identity come from the locked outbox row. This supersedes the original five-argument probe invocation, without relabeling earlier snapshots as integrated-release evidence.
