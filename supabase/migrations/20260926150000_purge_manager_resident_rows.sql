-- Manager "Delete resident" must remove every row in that manager's portfolio
-- linked to the resident, or remove nothing at all.
--
-- The resolver stays in TypeScript (`src/lib/auth/purge-manager-resident.ts`):
-- it authorizes the caller, matches the resident by email / user id /
-- application id per table, and hands this function the exact ids. One RPC call
-- is one transaction, so a failure anywhere rolls the whole delete back — the
-- earlier client-side sequence of independent deletes could (and did) leave a
-- signed lease behind while the application was already gone.
--
-- Two guards make the id list untrusted input rather than a delete-anything API:
--   * the table must appear in the allowlist below, which also names the column
--     that has to equal the calling manager;
--   * after each delete, no requested id may still exist. A row that survived
--     belongs to another portfolio, and the whole transaction aborts.
create or replace function public.purge_manager_resident_rows(p_manager uuid, p_targets jsonb)
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
    'portal_household_charge_records', 'manager_user_id',
    'portal_recurring_rent_profile_records', 'manager_user_id',
    'portal_service_request_records', 'manager_user_id',
    'portal_scheduled_inbox_message_records', 'manager_user_id',
    'resident_inspections', 'manager_user_id',
    'portal_lease_pipeline_records', 'manager_user_id',
    'portal_work_order_records', 'manager_user_id',
    'manager_documents', 'manager_user_id',
    'portal_inbox_thread_records', 'owner_user_id',
    'manager_application_records', 'manager_user_id'
  );
  entry jsonb;
  tbl text;
  owner_col text;
  ids text[];
  removed integer;
  surviving integer;
  result jsonb := '{}'::jsonb;
begin
  if p_manager is null then
    raise exception 'purge_manager_resident_rows: a manager is required';
  end if;
  if jsonb_typeof(p_targets) is distinct from 'array' then
    raise exception 'purge_manager_resident_rows: targets must be an array';
  end if;

  for entry in select value from jsonb_array_elements(p_targets) loop
    tbl := entry->>'table';
    owner_col := allowed->>tbl;
    if owner_col is null then
      raise exception 'purge_manager_resident_rows: % is not a purgeable table', coalesce(tbl, '(null)');
    end if;
    if jsonb_typeof(entry->'ids') is distinct from 'array' then
      raise exception 'purge_manager_resident_rows: % carries no id list', tbl;
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
      raise exception 'purge_manager_resident_rows: % row(s) in % are outside this portfolio', surviving, tbl;
    end if;

    result := result || jsonb_build_object(tbl, coalesce((result->>tbl)::integer, 0) + removed);
  end loop;

  return result;
end $$;

revoke all on function public.purge_manager_resident_rows(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.purge_manager_resident_rows(uuid, jsonb) to service_role;
