-- Strip applicant identity (SSN, date of birth, driver's license, sealed-identity
-- envelope) from lease records.
--
-- An approved application's plaintext identity used to be copied into
-- portal_lease_pipeline_records.row_data.application. The application row keeps
-- those fields sealed in _applicantIdentity; a lease never needs them, and every
-- lease reader (resident, teammates with Leases access, admin) could see them.
-- The code now strips them at every read and write boundary
-- (src/lib/lease-application-identity.ts); this removes what is already stored.
--
-- Idempotent: each statement only touches rows that still carry a key, so a
-- second run updates nothing.
--
-- NOT touched: generated_html / generatedHtml, signatures, documentSha256 and
-- every other row_data key. The signed document and its per-signature hash are
-- byte-identical.
--
-- updated_at is deliberately NOT set. It doubles as the lease's reviewRevision
-- (the optimistic-concurrency token a client sends back), so bumping it would
-- 409 every open editor for a change that alters nothing they can see. No
-- trigger on this table sets updated_at (there is no touch/moddatetime trigger
-- on portal_lease_pipeline_records), so a plain UPDATE that omits the column
-- leaves it as is.
--
-- Triggers: the table carries user triggers that must NOT run for a
-- data-hygiene rewrite:
--   enforce_signed_renewal_room_capacity (AFTER INSERT/UPDATE): on a fully
--     signed pendingRenewal row it writes manager_application_records
--     (updated_at = now(), moves the placement dates) and raises if the
--     application cannot be resolved. That would touch applications and could
--     abort the whole migration for a lease whose application is gone.
--   account_recovery_write_guard (BEFORE): raises 'Account recovery decision
--     required' for rows of an account in a recovery hold.
--   derive_test_workspace_provenance (BEFORE): re-derives workspace
--     provenance; nothing about it changes here.
-- The block below disables exactly the user triggers that are currently
-- enabled, runs the two UPDATEs, and re-enables exactly those. It is one
-- transaction: any failure rolls the trigger state back with the data.

-- Fail fast instead of blocking leases. `disable trigger` below takes an ACCESS EXCLUSIVE lock on
-- portal_lease_pipeline_records and holds it for the whole transaction, so an unbounded run would
-- queue behind — and then block — every live lease read and write. These bound both the wait for
-- the lock and the work done under it; on timeout the transaction rolls back and the block, being
-- idempotent, finishes the job on a later run in a quiet window. (`set local` outside the do block
-- so statement_timeout applies to the do statement itself; it no-ops with a notice if the migration
-- runner is not in a transaction.)
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $strip_lease_application_identity$
declare
  v_trigger record;
  v_disabled text[] := '{}';
  v_name text;
  v_keys constant text[] := array['ssn', 'dateOfBirth', 'driversLicense', '_applicantIdentity'];
begin
  for v_trigger in
    select tgname
    from pg_trigger
    where tgrelid = 'public.portal_lease_pipeline_records'::regclass
      and not tgisinternal
      and tgenabled = 'O'
  loop
    execute format('alter table public.portal_lease_pipeline_records disable trigger %I', v_trigger.tgname);
    v_disabled := array_append(v_disabled, v_trigger.tgname::text);
  end loop;

  -- 1. row_data.application
  update public.portal_lease_pipeline_records
  set row_data = jsonb_set(row_data, '{application}', (row_data -> 'application') - v_keys)
  where jsonb_typeof(row_data -> 'application') = 'object'
    and jsonb_path_exists(
      row_data,
      '$.application ? (exists(@."ssn") || exists(@."dateOfBirth") || exists(@."driversLicense") || exists(@."_applicantIdentity"))'
    );

  -- 2. row_data.signedLeaseSnapshots[*].application (order preserved)
  update public.portal_lease_pipeline_records
  set row_data = jsonb_set(
    row_data,
    '{signedLeaseSnapshots}',
    (
      select jsonb_agg(
        case
          when jsonb_typeof(snapshot.value -> 'application') = 'object'
            then jsonb_set(snapshot.value, '{application}', (snapshot.value -> 'application') - v_keys)
          else snapshot.value
        end
        order by snapshot.ordinality
      )
      from jsonb_array_elements(row_data -> 'signedLeaseSnapshots') with ordinality as snapshot(value, ordinality)
    )
  )
  where jsonb_typeof(row_data -> 'signedLeaseSnapshots') = 'array'
    and jsonb_path_exists(
      row_data,
      '$.signedLeaseSnapshots[*].application ? (exists(@."ssn") || exists(@."dateOfBirth") || exists(@."driversLicense") || exists(@."_applicantIdentity"))'
    );

  foreach v_name in array v_disabled loop
    execute format('alter table public.portal_lease_pipeline_records enable trigger %I', v_name);
  end loop;
end
$strip_lease_application_identity$;
