-- W5: phone authentication. All state transitions are service-only and atomic.
alter table public.phone_otp_challenges add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;
alter table public.phone_otp_challenges add column if not exists phone_e164 text;
alter table public.phone_otp_challenges add column if not exists browser_hash text;
alter table public.phone_otp_challenges add column if not exists completed_at timestamptz;
-- consumed_at also marks superseded/failed-delivery codes; it is NOT proof.
alter table public.phone_otp_challenges add column if not exists verified_at timestamptz;
alter table public.phone_otp_challenges add column if not exists auth_provider text;

-- Short leases span the separate Auth API and application-database calls.
-- This closes create-vs-attach races for legacy accounts with no Auth phone.
create table if not exists public.phone_auth_operation_locks (
  key text primary key,
  operation_id uuid not null,
  expires_at timestamptz not null
);
alter table public.phone_auth_operation_locks enable row level security;
revoke all on public.phone_auth_operation_locks from public, anon, authenticated;
grant select, insert, update, delete on public.phone_auth_operation_locks to service_role;

create or replace function public.phone_auth_claim_operation(p_operation uuid, p_phone text, p_user uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare lock_keys text[]; lock_key text;
begin
  if p_operation is null or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then return false; end if;
  lock_keys := array['phone:' || p_phone];
  if p_user is not null then lock_keys := array_append(lock_keys, 'user:' || p_user::text); end if;
  -- Every claimant takes the same order; one operation may extend its own
  -- phone lease with the account discovered after resolving that phone.
  for lock_key in select unnest(lock_keys) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('phone-auth-operation:' || lock_key, 0));
  end loop;
  if exists(select 1 from public.phone_auth_operation_locks
    where key = any(lock_keys) and expires_at > now() and operation_id <> p_operation) then return false; end if;
  delete from public.phone_auth_operation_locks where expires_at <= now();
  insert into public.phone_auth_operation_locks(key, operation_id, expires_at)
    select unnest(lock_keys), p_operation, now() + interval '5 minutes'
    on conflict(key) do update set operation_id = excluded.operation_id, expires_at = excluded.expires_at;
  return true;
end $$;

create or replace function public.phone_auth_release_operation(p_operation uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.phone_auth_operation_locks where operation_id = p_operation
$$;

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
    select id from public.profiles where phone_verified_at is not null and public.phone_auth_e164(phone::text) = p_phone
    union select id from auth.users where phone_confirmed_at is not null and public.phone_auth_e164('+' || ltrim(phone, '+')) = p_phone
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
  if c.auth_provider = 'local' then
    update public.phone_otp_challenges set consumed_at = now(), verified_at = now() where id = p_id;
  end if;
  return jsonb_build_object('id', c.id, 'phone', c.phone_e164, 'purpose', c.purpose, 'provider', c.auth_provider);
end $$;

create or replace function public.phone_auth_complete_native(p_id uuid, p_browser_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.phone_otp_challenges set consumed_at = now(), verified_at = now() where id = p_id and browser_hash = p_browser_hash
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

-- Public GoTrue phone-change APIs must not bypass the app's old-number proof.
-- A regular SMS sign-in may refresh an already-confirmed timestamp, but cannot
-- establish or replace a verified identity outside the guarded bind/reset.
create or replace function public.guard_auth_phone_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare old_phone text; new_phone text;
begin
  if current_setting('proplane.phone_auth_binding', true) = 'yes' then return new; end if;
  if not exists(select 1 from public.sms_runtime_config where singleton and line_mode = 'shared') then return new; end if;
  if new.phone is not distinct from old.phone and new.phone_confirmed_at is not distinct from old.phone_confirmed_at then return new; end if;
  old_phone := public.phone_auth_e164('+' || ltrim(old.phone, '+'));
  new_phone := public.phone_auth_e164('+' || ltrim(new.phone, '+'));
  if old_phone = new_phone and old.phone_confirmed_at is not null and new.phone_confirmed_at is not null then return new; end if;
  -- GoTrue admin.createUser confirms via UPDATE after INSERT. Only our trusted
  -- phone-only provisioning path can confirm here: app_metadata is admin-only,
  -- and its phone lease is acquired after a correct code, before user creation.
  if old.phone is not null and old_phone = new_phone and old.phone_confirmed_at is null
    and new.phone_confirmed_at is not null and old.raw_app_meta_data->'phone_only' = 'true'::jsonb
    and exists(select 1 from public.phone_auth_operation_locks where key = 'phone:' || new_phone and expires_at > now())
    and not exists(select 1 from unnest(public.phone_auth_owners(new_phone)) owner_id where owner_id <> new.id)
  then return new; end if;
  raise exception 'Use phone verification';
end $$;
drop trigger if exists guard_auth_phone_change on auth.users;
create trigger guard_auth_phone_change before update of phone, phone_confirmed_at on auth.users
  for each row execute function public.guard_auth_phone_change();

create or replace function public.phone_auth_bind(p_id uuid, p_user uuid, p_browser_hash text, p_old_id uuid, p_operation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.phone_otp_challenges%rowtype; old_c public.phone_otp_challenges%rowtype;
  prior public.profiles%rowtype; owners uuid[]; prior_phone text; auth_phone text;
begin
  -- Serialize all changes to an account, then the global phone ownership.
  perform pg_advisory_xact_lock(hashtextextended('phone-auth-user:' || p_user::text, 0));
  select * into c from public.phone_otp_challenges where id = p_id for update;
  if not found or c.browser_hash is distinct from p_browser_hash or c.verified_at is null or c.completed_at is not null
    or c.expires_at <= now() or c.purpose not in ('sign_in','change_number_new')
    or (c.auth_user_id is not null and c.auth_user_id <> p_user) then return false; end if;
  -- The caller must still own both leases after all external Auth lookups.
  -- Lock these rows so an expiry claimant cannot steal them during the bind.
  perform key from public.phone_auth_operation_locks
    where key in ('phone:' || c.phone_e164, 'user:' || p_user::text) order by key for update;
  if (select count(*) from public.phone_auth_operation_locks
    where key in ('phone:' || c.phone_e164, 'user:' || p_user::text)
      and operation_id = p_operation and expires_at > now()) <> 2 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-auth:' || c.phone_e164, 0));
  owners := public.phone_auth_owners(c.phone_e164);
  if exists(select 1 from unnest(owners) owner_id where owner_id <> p_user) then return false; end if;
  select * into prior from public.profiles where id = p_user for update;
  if prior.phone_verified_at is not null then prior_phone := public.phone_auth_e164(prior.phone::text); end if;
  select public.phone_auth_e164('+' || ltrim(phone, '+')) into auth_phone from auth.users
    where id = p_user and phone_confirmed_at is not null and phone is not null;
  -- Both readers recognize Auth confirmation as ownership. Never let an
  -- unverified/missing profile turn an Auth phone change into first-time bind.
  if prior_phone is not null and auth_phone is not null and prior_phone <> auth_phone then return false; end if;
  prior_phone := coalesce(prior_phone, auth_phone);
  if prior_phone is not null and prior_phone <> c.phone_e164 then
    select * into old_c from public.phone_otp_challenges where id = p_old_id for update;
    if not found or c.purpose <> 'change_number_new' or old_c.purpose <> 'change_number_old'
      or old_c.auth_user_id is distinct from p_user or old_c.browser_hash is distinct from p_browser_hash
      or old_c.phone_e164 <> prior_phone or old_c.verified_at is null
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
  -- Match GoTrue's phone identity shape (provider_id/sub = auth user UUID),
  -- and update its canonical digits-only phone in the SAME transaction. A
  -- failed unique constraint or identity write rolls the profile/contact back.
  -- Reference: supabase/auth internal/api/admin.go and internal/models/identity.go.
  insert into auth.identities(provider_id, user_id, provider, identity_data, created_at, updated_at)
    values(p_user::text, p_user, 'phone',
      jsonb_build_object('sub', p_user::text, 'phone', ltrim(c.phone_e164, '+'), 'phone_verified', true), now(), now())
    on conflict(provider_id, provider) do update
      set identity_data = coalesce(auth.identities.identity_data, '{}'::jsonb) || excluded.identity_data,
        updated_at = now()
      where auth.identities.user_id = excluded.user_id;
  if not found then raise exception 'Phone identity could not be bound'; end if;
  update auth.users set phone = ltrim(c.phone_e164, '+'), phone_confirmed_at = now(),
    phone_change = '', phone_change_token = '', phone_change_sent_at = null,
    raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{providers}',
      (select coalesce(jsonb_agg(provider order by provider), '[]'::jsonb)
        from (select distinct provider from auth.identities where user_id = p_user) providers)),
    updated_at = now()
    where id = p_user;
  if not found then raise exception 'Phone account could not be bound'; end if;
  update public.phone_otp_challenges set completed_at = now() where id = p_id;
  perform set_config('proplane.phone_auth_binding','',true);
  return true;
end $$;

revoke all on function public.phone_auth_e164(text), public.phone_auth_owners(text),
  public.phone_auth_claim_operation(uuid,text,uuid), public.phone_auth_release_operation(uuid),
  public.phone_auth_start(uuid,text,text,text,uuid,text,text,text), public.phone_auth_consume(uuid,uuid,text,text),
  public.phone_auth_complete_native(uuid,text), public.phone_auth_bind(uuid,uuid,text,uuid,uuid),
  public.guard_verified_phone_change(), public.guard_auth_phone_change() from public, anon, authenticated;
grant execute on function public.phone_auth_e164(text), public.phone_auth_owners(text),
  public.phone_auth_claim_operation(uuid,text,uuid), public.phone_auth_release_operation(uuid),
  public.phone_auth_start(uuid,text,text,text,uuid,text,text,text), public.phone_auth_consume(uuid,uuid,text,text),
  public.phone_auth_complete_native(uuid,text), public.phone_auth_bind(uuid,uuid,text,uuid,uuid),
  public.guard_verified_phone_change(), public.guard_auth_phone_change() to service_role;
