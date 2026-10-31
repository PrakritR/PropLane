-- A setup capability is frozen into the service-only, short-lived handoff.
alter table public.email_onboarding_handoffs add column if not exists application_setup_token_digest text;

-- Bind and consume the exact application capability in one locked transaction.
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
  if nullif(a.row_data->>'setupTokenConsumedAt', '') is not null then return bound = p_user::text; end if;
  update public.manager_application_records set row_data = jsonb_set(jsonb_set(a.row_data, '{residentUserId}', to_jsonb(p_user::text), true), '{setupTokenConsumedAt}', to_jsonb(now()), true), updated_at = now() where id = a.id;
  return true;
end $$;
revoke all on function public.bind_resident_setup_subject(text, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_resident_setup_subject(text, uuid, text) to service_role;
