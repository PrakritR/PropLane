create or replace function public.bind_resident_setup_subject(p_application text, p_user uuid, p_digest text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare a public.manager_application_records%rowtype; verified_email text; bound text;
begin
  if p_application is null or p_user is null or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then return false; end if;
  -- Shared with account_recovery_begin's exclusive lifecycle lock.
  if not pg_catalog.pg_try_advisory_xact_lock_shared(723081447301::bigint) then
    raise exception 'Account lifecycle transition in progress' using errcode = '40001';
  end if;
  select lower(btrim(email)) into verified_email from auth.users where id = p_user and email_confirmed_at is not null and deleted_at is null for share;
  if verified_email is null or verified_email = '' then return false; end if;
  if exists (select 1 from public.account_recovery_requests r where r.user_id = p_user and r.state in ('archiving', 'retained', 'recovering', 'purging')) then return false; end if;
  select * into a from public.manager_application_records where id = p_application for update;
  if not found or lower(btrim(a.resident_email)) is distinct from verified_email
    or a.row_data->>'setupTokenHash' is distinct from p_digest then return false; end if;
  bound := nullif(btrim(a.row_data->>'residentUserId'), '');
  if bound is not null and bound <> p_user::text then return false; end if;
  begin
    if nullif(a.row_data->>'setupTokenExpiresAt', '') is null or (a.row_data->>'setupTokenExpiresAt')::timestamptz <= now() then return false; end if;
  exception when invalid_datetime_format or datetime_field_overflow then return false; end;
  if nullif(a.row_data->>'setupTokenConsumedAt', '') is not null and bound is distinct from p_user::text then return false; end if;
  if nullif(a.row_data->>'setupTokenConsumedAt', '') is null then
    update public.manager_application_records set row_data = jsonb_set(jsonb_set(a.row_data, '{residentUserId}', to_jsonb(p_user::text), true), '{setupTokenConsumedAt}', to_jsonb(now()), true), updated_at = now() where id = a.id;
  end if;
  update public.resident_move_in_forms f set resident_user_id = p_user, updated_at = now()
  where f.application_id = a.id and f.resident_user_id is null and f.status = 'sent'
    and f.manager_user_id = a.manager_user_id
    and f.property_id = coalesce(nullif(a.assigned_property_id, ''), nullif(a.row_data->>'assignedPropertyId', ''), nullif(a.property_id, ''), nullif(a.row_data->>'propertyId', ''), nullif(a.row_data#>>'{application,propertyId}', ''))
    and lower(btrim(f.resident_email)) = verified_email
    and f.answers = '[]'::jsonb and f.signed_document_sha256 is null and f.submitted_at is null;
  return true;
end $$;
revoke all on function public.bind_resident_setup_subject(text, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_resident_setup_subject(text, uuid, text) to service_role;

-- Normal sends serialize on the same application row as subject claims.
create or replace function public.insert_bound_move_in_form(p_form jsonb)
returns public.resident_move_in_forms language plpgsql security definer set search_path = '' as $$
declare a public.manager_application_records%rowtype; candidate public.resident_move_in_forms%rowtype; result public.resident_move_in_forms%rowtype; bound text;
begin
  if not pg_catalog.pg_try_advisory_xact_lock_shared(723081447301::bigint) then
    raise exception 'Account lifecycle transition in progress' using errcode = '40001';
  end if;
  candidate := pg_catalog.jsonb_populate_record(null::public.resident_move_in_forms, p_form);
  select * into a from public.manager_application_records where id = candidate.application_id for update;
  if not found then raise exception 'Form application unavailable' using errcode = '23503'; end if;
  if nullif(btrim(candidate.resident_email), '') is null or nullif(btrim(a.resident_email), '') is null
    or candidate.manager_user_id is distinct from a.manager_user_id or candidate.property_id is distinct from
    coalesce(nullif(a.assigned_property_id, ''), nullif(a.row_data->>'assignedPropertyId', ''), nullif(a.property_id, ''), nullif(a.row_data->>'propertyId', ''), nullif(a.row_data#>>'{application,propertyId}', ''))
    or lower(btrim(candidate.resident_email)) is distinct from lower(btrim(a.resident_email)) then
    raise exception 'Form application mismatch' using errcode = '23514';
  end if;
  bound := nullif(btrim(a.row_data->>'residentUserId'), '');
  if candidate.resident_user_id is not null and candidate.resident_user_id::text is distinct from bound then
    raise exception 'Form subject mismatch' using errcode = '23514';
  end if;
  insert into public.resident_move_in_forms (application_id,manager_user_id,property_id,property_label,room_label,resident_name,resident_email,resident_user_id,form_id,form_name,source,snapshot,status,answers,due_at)
  values (candidate.application_id,candidate.manager_user_id,candidate.property_id,candidate.property_label,candidate.room_label,candidate.resident_name,candidate.resident_email,bound::uuid,candidate.form_id,candidate.form_name,candidate.source,candidate.snapshot,'sent','[]'::jsonb,candidate.due_at)
  returning * into result;
  return result;
end $$;
revoke all on function public.insert_bound_move_in_form(jsonb) from public, anon, authenticated;
grant execute on function public.insert_bound_move_in_form(jsonb) to service_role;
