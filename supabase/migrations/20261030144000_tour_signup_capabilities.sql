create table if not exists public.tour_signup_capabilities (
  id uuid primary key default gen_random_uuid(),
  token_digest text not null unique,
  inquiry_id text not null,
  recipient_email text not null,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  property_id text not null,
  tour_group_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_user_id uuid references auth.users(id) on delete cascade,
  check ((consumed_at is null) = (consumed_user_id is null)),
  check (expires_at > created_at)
);
alter table public.tour_signup_capabilities enable row level security;
revoke all on public.tour_signup_capabilities from public, anon, authenticated;
grant all on public.tour_signup_capabilities to service_role;
create index if not exists tour_signup_capabilities_email_idx on public.tour_signup_capabilities(recipient_email);
create index if not exists tour_signup_capabilities_expiry_idx on public.tour_signup_capabilities(expires_at);
alter table public.email_onboarding_handoffs add column if not exists tour_capability_id uuid references public.tour_signup_capabilities(id) on delete cascade;
create or replace function public.claim_tour_signup_capability(p_digest text, p_inquiry_id text, p_email text, p_user_id uuid, p_token_digest text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare cap_id uuid;
begin
  update public.tour_signup_capabilities set consumed_at = coalesce(consumed_at, now()), consumed_user_id = p_user_id
  where token_digest = p_digest and inquiry_id = p_inquiry_id and recipient_email = p_email
    and (consumed_user_id is null or consumed_user_id = p_user_id) and expires_at > now()
  returning id into cap_id;
  if cap_id is null then return false; end if;
  insert into public.email_onboarding_handoffs (user_id, token_digest, intent, tour_inquiry_id, tour_capability_id, expires_at)
  values (p_user_id, p_token_digest, 'tour', p_inquiry_id, cap_id, now() + interval '1 hour');
  return true;
end;
$$;
revoke all on function public.claim_tour_signup_capability(text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_tour_signup_capability(text,text,text,uuid,text) to service_role;
create or replace function public.purge_expired_tour_signup_capabilities()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.tour_signup_capabilities where id in (
    select c.id from public.tour_signup_capabilities c
    where c.expires_at < now() and not exists (select 1 from public.email_onboarding_handoffs h where h.tour_capability_id = c.id and h.expires_at > now())
    order by c.expires_at limit 100
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.purge_expired_tour_signup_capabilities() from public, anon, authenticated;
grant execute on function public.purge_expired_tour_signup_capabilities() to service_role;
create or replace function public.bind_resident_tour_link(p_user_id uuid, p_inquiry_id text, p_group_id text, p_manager_id uuid, p_property_id text, p_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_group_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-group:' || p_group_id, 0)); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-inquiry:' || p_inquiry_id, 0));
  if exists (select 1 from public.resident_tour_links where resident_user_id <> p_user_id and (inquiry_id = p_inquiry_id or (p_group_id is not null and tour_group_id = p_group_id))) then return false; end if;
  insert into public.resident_tour_links (resident_user_id, inquiry_id, tour_group_id, manager_user_id, property_id, attendee_email)
  values (p_user_id, p_inquiry_id, p_group_id, p_manager_id, p_property_id, p_email)
  on conflict (resident_user_id, inquiry_id) do nothing;
  return true;
end;
$$;
revoke all on function public.bind_resident_tour_link(uuid,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.bind_resident_tour_link(uuid,text,text,uuid,text,text) to service_role;
-- A deleted Auth user must not make an old tour assignable to a new login.
create table if not exists public.tour_subject_bindings (
  binding_key text primary key,
  subject_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.tour_subject_bindings enable row level security;
revoke all on public.tour_subject_bindings from public, anon, authenticated;
grant all on public.tour_subject_bindings to service_role;
revoke insert, update, delete on public.resident_tour_links from public, anon, authenticated;
create or replace function public.guard_tour_subject_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.resident_tour_links; k text; h text; existing_hash text;
begin
  if tg_op = 'UPDATE' and (old.resident_user_id is distinct from new.resident_user_id or old.inquiry_id is distinct from new.inquiry_id or old.tour_group_id is distinct from new.tour_group_id) then raise exception 'Tour binding is immutable'; end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.tour_group_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-group:' || r.tour_group_id, 0)); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-inquiry:' || r.inquiry_id, 0));
  h := public.account_identity_hash(r.resident_user_id::text);
  foreach k in array array['inquiry:' || r.inquiry_id, case when r.tour_group_id is not null then 'group:' || r.tour_group_id else null end] loop
    if k is null then continue; end if;
    select subject_hash into existing_hash from public.tour_subject_bindings where binding_key = k;
    if tg_op <> 'DELETE' and existing_hash is not null and existing_hash <> h then raise exception 'Tour is bound to another account'; end if;
    insert into public.tour_subject_bindings(binding_key, subject_hash) values (k, h) on conflict (binding_key) do nothing;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  delete from public.tour_signup_capabilities where consumed_user_id is null and (inquiry_id = r.inquiry_id or (r.tour_group_id is not null and tour_group_id = r.tour_group_id));
  return new;
end;
$$;
revoke all on function public.guard_tour_subject_binding() from public, anon, authenticated;
drop trigger if exists guard_tour_subject_binding on public.resident_tour_links;
create trigger guard_tour_subject_binding before insert or update or delete on public.resident_tour_links for each row execute function public.guard_tour_subject_binding();
create or replace function public.issue_tour_signup_capability(p_digest text, p_inquiry_id text, p_email text, p_manager_id uuid, p_property_id text, p_group_id text, p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_group_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-group:' || p_group_id, 0)); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tour-inquiry:' || p_inquiry_id, 0));
  if exists (select 1 from public.tour_subject_bindings where binding_key = 'inquiry:' || p_inquiry_id or (p_group_id is not null and binding_key = 'group:' || p_group_id)) then return false; end if;
  if exists (select 1 from public.resident_tour_links where inquiry_id = p_inquiry_id or (p_group_id is not null and tour_group_id = p_group_id)) then return false; end if;
  insert into public.tour_signup_capabilities(token_digest, inquiry_id, recipient_email, manager_user_id, property_id, tour_group_id, expires_at) values (p_digest, p_inquiry_id, p_email, p_manager_id, p_property_id, p_group_id, p_expires_at);
  return true;
end;
$$;
revoke all on function public.issue_tour_signup_capability(text,text,text,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.issue_tour_signup_capability(text,text,text,uuid,text,text,timestamptz) to service_role;
