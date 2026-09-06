-- Preserve encrypted document aliases and logical children when a legacy
-- application primary key becomes its canonical display ID. Object paths are
-- immutable: their folder already normalizes both IDs, and paths bind the AAD.
create or replace function public.normalize_application_record_id(
  p_old_id text,
  p_expected jsonb,
  p_next jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row public.manager_application_records%rowtype;
  new_id text := p_next->>'id';
begin
  if p_old_id is null or p_old_id = '' or new_id is null or new_id = '' or new_id = p_old_id
     or jsonb_typeof(p_expected) is distinct from 'object'
     or jsonb_typeof(p_next->'row_data') is distinct from 'object'
     or p_next->'row_data'->>'id' is distinct from new_id then
    raise exception 'Invalid application normalization request';
  end if;

  if new_id is distinct from (case
    when upper(btrim(p_old_id)) like 'AXIS-%' or upper(btrim(p_old_id)) like 'PROPLANE-%' then btrim(p_old_id)
    else 'PROPLANE-' || left(upper(regexp_replace(btrim(p_old_id), '[^a-zA-Z0-9]', '', 'g')), 12)
  end) then raise exception 'Invalid application normalization target'; end if;

  select * into old_row from public.manager_application_records where id = p_old_id for update;
  if not found then raise exception 'Application normalization source unavailable'; end if;
  -- Both ownership columns and row_data are the previously authorized snapshot.
  -- A concurrent submit, transfer, token rotation or document edit must retry.
  if old_row.row_data is distinct from p_expected->'row_data'
     or old_row.manager_user_id is distinct from (p_expected->>'manager_user_id')::uuid
     or old_row.resident_email is distinct from p_expected->>'resident_email'
     or old_row.property_id is distinct from p_expected->>'property_id'
     or old_row.assigned_property_id is distinct from p_expected->>'assigned_property_id'
     or old_row.manager_user_id is distinct from (p_next->>'manager_user_id')::uuid then
    raise exception 'Application normalization source changed';
  end if;

  if p_next->'row_data'->>'bucket' = 'pending'
     and lower(btrim(p_next->'row_data'->>'stage')) = 'in progress'
     and (old_row.row_data->>'bucket' is distinct from 'pending'
       or lower(btrim(old_row.row_data->>'stage')) is distinct from 'in progress'
       or old_row.row_data->>'withdrawnAt' is not null) then
    raise exception 'Application draft is no longer writable';
  end if;

  -- No ON CONFLICT: a different row with this exact target PK is never merged,
  -- even if it has the same manager. The insert also arbitrates concurrent IDs.
  insert into public.manager_application_records
    (id, manager_user_id, resident_email, property_id, assigned_property_id, row_data, created_at, updated_at)
  values (new_id, old_row.manager_user_id, p_next->>'resident_email',
    p_next->>'property_id', p_next->>'assigned_property_id', p_next->'row_data', old_row.created_at, now());

  update public.application_document_storage_aliases set application_id = new_id where application_id = p_old_id;
  update public.cosigner_submission_records
    set signer_app_id = new_id, row_data = jsonb_set(row_data, '{signerAppId}', to_jsonb(new_id)), updated_at = now()
    where signer_app_id = p_old_id;
  update public.screening_orders set application_id = new_id where application_id = p_old_id;
  update public.application_fee_waiver_redemptions set application_id = new_id where application_id = p_old_id;

  -- The alias FK now points to the new parent, so this cannot cascade its map.
  -- Every step above shares this statement's transaction and rolls back on error.
  delete from public.manager_application_records where id = p_old_id;
end;
$$;
revoke all on function public.normalize_application_record_id(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.normalize_application_record_id(text, jsonb, jsonb) to service_role;
