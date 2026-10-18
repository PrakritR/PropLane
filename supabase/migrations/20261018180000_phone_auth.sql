-- W5: phone authentication. All state transitions are service-only and atomic.
alter table public.phone_otp_challenges add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;
alter table public.phone_otp_challenges add column if not exists phone_e164 text;
alter table public.phone_otp_challenges add column if not exists browser_hash text;
alter table public.phone_otp_challenges add column if not exists completed_at timestamptz;
alter table public.phone_otp_challenges add column if not exists auth_provider text;

create or replace function public.phone_auth_e164(raw_phone text) returns text
language sql immutable set search_path = '' as $$
  select case when raw_phone like '+%' then '+' || regexp_replace(raw_phone, '[^0-9]', '', 'g')
    when length(regexp_replace(raw_phone, '[^0-9]', '', 'g')) = 10 then '+1' || regexp_replace(raw_phone, '[^0-9]', '', 'g')
    else '+' || regexp_replace(raw_phone, '[^0-9]', '', 'g') end
$$;

-- A contact binding is authoritative too: a stale/ambiguous binding refuses
-- authentication rather than choosing one of several accounts.
create or replace function public.phone_auth_owners(p_phone text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct id), '{}'::uuid[]) from (
    select id from public.profiles where phone_verified_at is not null and public.phone_auth_e164(phone) = p_phone
    union select id from auth.users where phone_confirmed_at is not null and public.phone_auth_e164(phone) = p_phone
    union select user_id from public.sms_phone_contacts where phone_e164 = p_phone and user_id is not null
  ) owners
$$;

create or replace function public.phone_auth_start(
  p_id uuid, p_phone text, p_phone_key text, p_purpose text, p_user uuid,
  p_browser_hash text, p_code_hash text, p_provider text default 'local'
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_purpose not in ('sign_in','change_number_old','change_number_new') or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or p_browser_hash is null or p_code_hash is null or p_provider not in ('local','supabase') then return false; end if;
  if p_purpose <> 'sign_in' and p_user is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || p_phone, 0));
  -- Count all callers and purposes, including failed deliveries. Retrying a
  -- provider failure must not buy an attacker an unlimited SMS budget.
  if (select count(*) from public.phone_otp_challenges where phone_key = p_phone_key and created_at > now() - interval '1 hour') >= 3 then return false; end if;
  update public.phone_otp_challenges set consumed_at = now()
    where phone_key = p_phone_key and purpose = p_purpose and auth_user_id is not distinct from p_user and consumed_at is null;
  insert into public.phone_otp_challenges(id, phone_key, purpose, subject_id, auth_user_id, phone_e164, browser_hash, code_hash, auth_provider, expires_at)
    values(p_id, p_phone_key, p_purpose, p_user::text, p_user, p_phone, p_browser_hash, p_code_hash, p_provider, now() + interval '10 minutes');
  return true;
end $$;

-- Local verification consumes the code exactly once. Supabase verification
-- reserves one attempt first; its successful result is consumed separately.
create or replace function public.phone_auth_consume(p_id uuid, p_user uuid, p_browser_hash text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.phone_otp_challenges%rowtype;
begin
  select * into c from public.phone_otp_challenges where id = p_id for update;
  if not found or c.browser_hash is distinct from p_browser_hash or c.auth_user_id is distinct from p_user
    or c.consumed_at is not null or c.expires_at <= now() or c.attempts >= 5 then return null; end if;
  update public.phone_otp_challenges set attempts = attempts + 1 where id = p_id;
  if c.auth_provider = 'local' and c.code_hash <> p_code_hash then return null; end if;
  if c.auth_provider = 'local' then update public.phone_otp_challenges set consumed_at = now() where id = p_id; end if;
  return jsonb_build_object('id', c.id, 'phone', c.phone_e164, 'purpose', c.purpose, 'provider', c.auth_provider);
end $$;

create or replace function public.phone_auth_complete_native(p_id uuid, p_browser_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.phone_otp_challenges set consumed_at = now() where id = p_id and browser_hash = p_browser_hash
    and auth_provider = 'supabase' and consumed_at is null and expires_at > now() and attempts <= 5;
  return found;
end $$;

-- No route may silently replace a verified identity. This also closes future
-- profile writers which forget the old-number proof. Per-workspace is unchanged.
create or replace function public.guard_verified_phone_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('proplane.phone_auth_binding', true) = 'yes' then return new; end if;
  if not exists(select 1 from public.sms_runtime_config where singleton and line_mode = 'shared') then return new; end if;
  if tg_op = 'INSERT' then
    if new.phone_verified_at is not null then raise exception 'Use phone verification'; end if;
  elsif new.phone is distinct from old.phone or new.phone_verified_at is distinct from old.phone_verified_at then
    if old.phone_verified_at is not null or new.phone_verified_at is not null then raise exception 'Use phone verification'; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_verified_phone_change on public.profiles;
create trigger guard_verified_phone_change before insert or update on public.profiles for each row execute function public.guard_verified_phone_change();

create or replace function public.phone_auth_bind(p_id uuid, p_user uuid, p_browser_hash text, p_old_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.phone_otp_challenges%rowtype; old_c public.phone_otp_challenges%rowtype;
  prior public.profiles%rowtype; owners uuid[];
begin
  -- Serialize all changes to an account, then the global phone ownership.
  perform pg_advisory_xact_lock(hashtextextended('phone-auth-user:' || p_user::text, 0));
  select * into c from public.phone_otp_challenges where id = p_id for update;
  if not found or c.browser_hash is distinct from p_browser_hash or c.consumed_at is null or c.completed_at is not null
    or c.expires_at <= now() or c.purpose not in ('sign_in','change_number_new')
    or (c.auth_user_id is not null and c.auth_user_id <> p_user) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || c.phone_e164, 0));
  owners := public.phone_auth_owners(c.phone_e164);
  if exists(select 1 from unnest(owners) owner_id where owner_id <> p_user) then return false; end if;
  select * into prior from public.profiles where id = p_user for update;
  if prior.phone_verified_at is not null and public.phone_auth_e164(prior.phone) <> c.phone_e164 then
    select * into old_c from public.phone_otp_challenges where id = p_old_id for update;
    if not found or c.purpose <> 'change_number_new' or old_c.purpose <> 'change_number_old'
      or old_c.auth_user_id is distinct from p_user or old_c.browser_hash is distinct from p_browser_hash
      or old_c.phone_e164 <> public.phone_auth_e164(prior.phone) or old_c.consumed_at is null
      or old_c.completed_at is not null or old_c.expires_at <= now() then return false; end if;
    update public.phone_otp_challenges set completed_at = now() where id = p_old_id;
  end if;
  perform set_config('proplane.phone_auth_binding','yes',true);
  insert into public.profiles(id, role, phone, phone_verified_at)
    values(p_user, 'resident', c.phone_e164, now()) on conflict(id) do update
    set phone = excluded.phone, phone_verified_at = excluded.phone_verified_at, updated_at = now();
  -- Keep existing roles; the new phone-only account starts role-agnostic as a resident.
  if not exists(select 1 from public.profile_roles where user_id = p_user) then
    insert into public.profile_roles(user_id, role) select p_user, case when role = 'owner' then 'manager' else role end
      from public.profiles where id = p_user on conflict do nothing;
  end if;
  update public.sms_phone_contacts set user_id = null where user_id = p_user and phone_e164 <> c.phone_e164;
  insert into public.sms_phone_contacts(phone_e164, phone_key, user_id) values(c.phone_e164, c.phone_key, p_user)
    on conflict(phone_e164) do update set user_id = excluded.user_id, last_seen_at = now();
  update public.phone_otp_challenges set completed_at = now() where id = p_id;
  perform set_config('proplane.phone_auth_binding','',true);
  return true;
end $$;

revoke all on function public.phone_auth_e164(text), public.phone_auth_owners(text),
  public.phone_auth_start(uuid,text,text,text,uuid,text,text,text), public.phone_auth_consume(uuid,uuid,text,text),
  public.phone_auth_complete_native(uuid,text), public.phone_auth_bind(uuid,uuid,text,uuid),
  public.guard_verified_phone_change() from public, anon, authenticated;
grant execute on function public.phone_auth_e164(text), public.phone_auth_owners(text),
  public.phone_auth_start(uuid,text,text,text,uuid,text,text,text), public.phone_auth_consume(uuid,uuid,text,text),
  public.phone_auth_complete_native(uuid,text), public.phone_auth_bind(uuid,uuid,text,uuid),
  public.guard_verified_phone_change() to service_role;
