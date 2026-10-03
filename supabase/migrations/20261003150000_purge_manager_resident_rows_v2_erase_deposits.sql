-- Captain, Oct 3: deleting a resident erases them fully, so the resident cascade may
-- also delete their security_deposit_ledger rows (manager-scoped like every table).
-- Same function, one table added to the delete allowlist; idempotent (create or replace).

-- Manager "Delete resident", second pass (studio-redesign-0929 C2-DT2).
--
-- v1 (`purge_manager_resident_rows`, 20260927170000) deletes a resident's rows
-- but leaves behind the Bookings calendar blocks that name them, the work
-- number's texts, and treats paid money like any other charge. v2 keeps the
-- same contract (the TypeScript resolver authorizes and picks exact ids; one
-- call is one transaction; a requested id that survives aborts everything) and
-- adds two things:
--
--   * more deletable tables: manager-closed date blocks (`portal_schedule_records`),
--     the work number's text log (`manager_sms_messages`, `inbound_sms_log`,
--     `manager_sms_contacts`) and the accrual lines of deleted unpaid charges
--     (`ledger_entries`);
--   * an ANONYMIZE phase: paid charges, their ledger lines and held deposits are
--     money the manager really received, so they stay (income and deposit totals
--     still add up) but lose every pointer to the person.
--
-- v1 stays installed, untouched, so a deploy that lands before this migration
-- keeps working until the application code is switched over.
create or replace function public.purge_manager_resident_rows_v2(
  p_manager uuid,
  p_targets jsonb,
  p_anonymize jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- table -> the column that must equal p_manager. Deletes run in the order the
  -- caller supplies (children before parents); this map only authorizes.
  allowed constant jsonb := jsonb_build_object(
    'cosigner_submission_records', 'manager_user_id',
    'screening_orders', 'manager_user_id',
    'portal_reminder_records', 'manager_user_id',
    'payment_reminder_occurrences', 'manager_user_id',
    'resident_autopay_runs', 'manager_id',
    'resident_autopay_settings', 'manager_id',
    'security_deposit_ledger', 'manager_user_id',
    'ledger_entries', 'manager_user_id',
    'portal_household_charge_records', 'manager_user_id',
    'portal_recurring_rent_profile_records', 'manager_user_id',
    'portal_service_request_records', 'manager_user_id',
    'portal_scheduled_inbox_message_records', 'manager_user_id',
    'resident_inspections', 'manager_user_id',
    'portal_lease_pipeline_records', 'manager_user_id',
    'portal_work_order_records', 'manager_user_id',
    'manager_documents', 'manager_user_id',
    'portal_inbox_thread_records', 'owner_user_id',
    'portal_schedule_records', 'manager_user_id',
    'manager_sms_messages', 'manager_user_id',
    'inbound_sms_log', 'manager_user_id',
    'manager_sms_contacts', 'manager_user_id',
    'manager_application_records', 'manager_user_id'
  );
  -- Tables whose rows may be anonymized in place instead of deleted.
  anonymizable constant jsonb := jsonb_build_object(
    'portal_household_charge_records', 'manager_user_id',
    'ledger_entries', 'manager_user_id',
    'security_deposit_ledger', 'manager_user_id'
  );
  entry jsonb;
  tbl text;
  owner_col text;
  ids text[];
  removed integer;
  surviving integer;
  changed integer;
  result jsonb := '{}'::jsonb;
  anonymized jsonb := '{}'::jsonb;
begin
  if p_manager is null then
    raise exception 'purge_manager_resident_rows_v2: a manager is required';
  end if;
  if jsonb_typeof(p_targets) is distinct from 'array' then
    raise exception 'purge_manager_resident_rows_v2: targets must be an array';
  end if;
  if jsonb_typeof(p_anonymize) is distinct from 'array' then
    raise exception 'purge_manager_resident_rows_v2: anonymize must be an array';
  end if;

  -- Anonymize first: a paid charge must be detached from the person before the
  -- delete phase, and a failure anywhere rolls both phases back together.
  for entry in select value from jsonb_array_elements(p_anonymize) loop
    tbl := entry->>'table';
    owner_col := anonymizable->>tbl;
    if owner_col is null then
      raise exception 'purge_manager_resident_rows_v2: % cannot be anonymized', coalesce(tbl, '(null)');
    end if;
    if jsonb_typeof(entry->'ids') is distinct from 'array' then
      raise exception 'purge_manager_resident_rows_v2: % carries no id list', tbl;
    end if;
    select coalesce(array_agg(value), '{}'::text[]) into ids
      from jsonb_array_elements_text(entry->'ids') as t(value);
    if array_length(ids, 1) is null then
      continue;
    end if;

    if tbl = 'portal_household_charge_records' then
      update public.portal_household_charge_records
         set resident_user_id = null,
             resident_email = null,
             row_data = (
               row_data
               - 'residentEmail' - 'residentName' - 'residentUserId' - 'applicationId' - 'residentChargeMessages'
             ) || jsonb_build_object(
               'residentEmail', '',
               'residentName', '',
               'residentUserId', null,
               'anonymized', true
             ),
             updated_at = now()
       where id::text = any(ids) and manager_user_id = p_manager;
    elsif tbl = 'ledger_entries' then
      update public.ledger_entries
         set resident_user_id = null,
             resident_email = null,
             updated_at = now()
       where id::text = any(ids) and manager_user_id = p_manager;
    else
      update public.security_deposit_ledger
         set resident_user_id = null,
             resident_email = '',
             updated_at = now()
       where id::text = any(ids) and manager_user_id = p_manager;
    end if;
    get diagnostics changed = row_count;
    if changed <> array_length(ids, 1) then
      raise exception 'purge_manager_resident_rows_v2: % row(s) in % are outside this portfolio',
        array_length(ids, 1) - changed, tbl;
    end if;
    anonymized := anonymized || jsonb_build_object(tbl, coalesce((anonymized->>tbl)::integer, 0) + changed);
  end loop;

  for entry in select value from jsonb_array_elements(p_targets) loop
    tbl := entry->>'table';
    owner_col := allowed->>tbl;
    if owner_col is null then
      raise exception 'purge_manager_resident_rows_v2: % is not a purgeable table', coalesce(tbl, '(null)');
    end if;
    if jsonb_typeof(entry->'ids') is distinct from 'array' then
      raise exception 'purge_manager_resident_rows_v2: % carries no id list', tbl;
    end if;
    select coalesce(array_agg(value), '{}'::text[]) into ids
      from jsonb_array_elements_text(entry->'ids') as t(value);
    if array_length(ids, 1) is null then
      continue;
    end if;

    execute format('delete from public.%I where id::text = any($1) and %I = $2', tbl, owner_col)
      using ids, p_manager;
    get diagnostics removed = row_count;

    -- Tolerates a row already removed by an earlier phase's cascade (count is
    -- lower) but never a row this manager does not own (the row is still there).
    execute format('select count(*) from public.%I where id::text = any($1)', tbl)
      using ids into surviving;
    if surviving > 0 then
      raise exception 'purge_manager_resident_rows_v2: % row(s) in % are outside this portfolio', surviving, tbl;
    end if;

    result := result || jsonb_build_object(tbl, coalesce((result->>tbl)::integer, 0) + removed);
  end loop;

  return jsonb_build_object('deleted', result, 'anonymized', anonymized);
end $$;

revoke all on function public.purge_manager_resident_rows_v2(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.purge_manager_resident_rows_v2(uuid, jsonb, jsonb) to service_role;
