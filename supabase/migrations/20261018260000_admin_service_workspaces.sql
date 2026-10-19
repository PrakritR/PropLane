-- PropLane Service inside the admin account (one-number W15).
--
-- A "service workspace" is an ordinary portal_workspaces row owned by ONE
-- designated service owner account. Admin operators reach it as members with the
-- Admin role (account_link_invites, the existing membership model) - there is no
-- parallel workspace system. This migration adds only:
--   * platform_service_settings - the singleton naming the service owner, so the
--     database (not just the app) knows whose workspaces are exempt from the cap;
--   * portal_workspaces.is_service / city - which of the owner's workspaces are the
--     per-city PropLane Service ones;
--   * the owner-count ceiling skips the service owner;
--   * create_portal_service_workspace - the one writer, service_role only, refuses
--     any owner that is not the configured service owner.
-- Additive and idempotent. Nothing here changes behaviour for any other owner.

create table if not exists public.platform_service_settings (
  singleton boolean primary key default true check (singleton),
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.platform_service_settings enable row level security;
revoke all on public.platform_service_settings from anon, authenticated;
grant all on public.platform_service_settings to service_role;

alter table public.portal_workspaces add column if not exists is_service boolean not null default false;
alter table public.portal_workspaces add column if not exists city text;
alter table public.portal_workspaces drop constraint if exists portal_workspaces_city_length;
alter table public.portal_workspaces add constraint portal_workspaces_city_length
  check (city is null or length(btrim(city)) between 1 and 80);
create index if not exists portal_workspaces_service_idx
  on public.portal_workspaces(owner_user_id) where is_service;

-- The ceiling of 10 owned workspaces stays for everyone except the service owner.
create or replace function public.enforce_portal_workspace_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and new.owner_user_id = old.owner_user_id then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-owner:' || new.owner_user_id::text, 0));
  if TG_OP = 'INSERT' and new.is_default and exists (
    select 1 from public.portal_workspaces where owner_user_id = new.owner_user_id and is_default
  ) then return new; end if;
  if exists (select 1 from public.platform_service_settings where owner_user_id = new.owner_user_id) then
    return new;
  end if;
  if (select count(*) from public.portal_workspaces where owner_user_id = new.owner_user_id) >= 10 then
    raise exception 'You can own up to 10 workspaces.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_portal_workspace_limit() from public, anon, authenticated;

-- Creates one service workspace. Only the configured service owner may own one;
-- the first becomes the owner's default so no stray "My workspace" is minted.
create or replace function public.create_portal_service_workspace(
  p_owner uuid,
  p_name text,
  p_city text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_workspace_id uuid;
  has_default boolean;
begin
  if p_owner is null then
    raise exception 'Workspace owner is required.' using errcode = '22023';
  end if;
  if p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 80 then
    raise exception 'Workspace name must be between 1 and 80 characters.' using errcode = '22023';
  end if;
  if p_city is not null and pg_catalog.length(pg_catalog.btrim(p_city)) not between 1 and 80 then
    raise exception 'City must be between 1 and 80 characters.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.platform_service_settings where owner_user_id = p_owner
  ) then
    raise exception 'That account is not the PropLane service owner.' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workspace-owner:' || p_owner::text, 0)
  );
  select exists (
    select 1 from public.portal_workspaces where owner_user_id = p_owner and is_default
  ) into has_default;
  insert into public.portal_workspaces (owner_user_id, name, is_default, is_service, city)
  values (
    p_owner,
    pg_catalog.btrim(p_name),
    not has_default,
    true,
    nullif(pg_catalog.btrim(coalesce(p_city, '')), '')
  )
  returning id into created_workspace_id;
  return created_workspace_id;
end;
$$;
revoke all on function public.create_portal_service_workspace(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_portal_service_workspace(uuid, text, text) to service_role;
