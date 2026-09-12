-- Workspaces group property records without changing their legal/payout owner.
-- Existing portfolios remain intact, even when already above the new cap.
create table if not exists public.portal_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists portal_workspaces_default_owner
  on public.portal_workspaces(owner_user_id) where is_default;
alter table public.portal_workspaces enable row level security;
revoke all on public.portal_workspaces from anon, authenticated;
grant select on public.portal_workspaces to authenticated;
grant all on public.portal_workspaces to service_role;
drop policy if exists portal_workspaces_owner_read on public.portal_workspaces;
create policy portal_workspaces_owner_read on public.portal_workspaces
  for select to authenticated using (owner_user_id = auth.uid());

alter table public.manager_property_records add column if not exists workspace_id uuid
  references public.portal_workspaces(id) on delete restrict;
create index if not exists manager_property_records_workspace_idx
  on public.manager_property_records(workspace_id);

insert into public.portal_workspaces(owner_user_id, name, is_default)
select distinct p.manager_user_id, 'My workspace', true
from public.manager_property_records p join public.profiles owner on owner.id = p.manager_user_id
where p.manager_user_id is not null
on conflict (owner_user_id) where is_default do nothing;
update public.manager_property_records p set workspace_id = w.id
from public.portal_workspaces w
where p.workspace_id is null and w.owner_user_id = p.manager_user_id and w.is_default;

create or replace function public.enforce_portal_workspace_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and new.owner_user_id = old.owner_user_id then return new; end if;
  -- The owner lock serializes separate-tab/concurrent creation at the database.
  perform pg_advisory_xact_lock(hashtextextended('workspace-owner:' || new.owner_user_id::text, 0));
  if TG_OP = 'INSERT' and new.is_default and exists (
    select 1 from public.portal_workspaces where owner_user_id = new.owner_user_id and is_default
  ) then return new; end if;
  if (select count(*) from public.portal_workspaces where owner_user_id = new.owner_user_id) >= 3 then
    raise exception 'You can own up to 3 workspaces.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_portal_workspace_limit() from public, anon, authenticated;
drop trigger if exists portal_workspace_limit on public.portal_workspaces;
create trigger portal_workspace_limit before insert or update of owner_user_id
on public.portal_workspaces for each row execute function public.enforce_portal_workspace_limit();

create or replace function public.ensure_default_portal_workspace(p_owner uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare result uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('workspace-owner:' || p_owner::text, 0));
  select id into result from public.portal_workspaces where owner_user_id = p_owner and is_default;
  if result is null then
    insert into public.portal_workspaces(owner_user_id, name, is_default)
      values (p_owner, 'My workspace', true) returning id into result;
  end if;
  return result;
end;
$$;
revoke all on function public.ensure_default_portal_workspace(uuid) from public, anon, authenticated;
grant execute on function public.ensure_default_portal_workspace(uuid) to service_role;

create or replace function public.enforce_property_workspace()
returns trigger language plpgsql security definer set search_path = public as $$
declare workspace_owner uuid; existing_workspace uuid; existing_owner uuid;
begin
  if new.manager_user_id is null then new.workspace_id := null; return new; end if;
  if TG_OP = 'INSERT' then
    -- UPSERT runs BEFORE INSERT before deciding ON CONFLICT UPDATE. It must
    -- neither charge a second slot nor move an existing record to the default.
    select workspace_id, manager_user_id into existing_workspace, existing_owner
      from public.manager_property_records where id = new.id;
    if existing_owner = new.manager_user_id and new.workspace_id is null then
      new.workspace_id := existing_workspace;
    end if;
  end if;
  -- Transfers retain the existing ownership workflow; never keep a previous
  -- owner's workspace attached to the transferred property.
  if TG_OP = 'UPDATE' and new.manager_user_id is distinct from old.manager_user_id then
    new.workspace_id := null;
  end if;
  if new.workspace_id is null then
    new.workspace_id := public.ensure_default_portal_workspace(new.manager_user_id);
  end if;
  select owner_user_id into workspace_owner from public.portal_workspaces
    where id = new.workspace_id for update;
  if workspace_owner is distinct from new.manager_user_id then
    raise exception 'The property and workspace must have the same owner.' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and new.workspace_id is not distinct from old.workspace_id then return new; end if;
  if TG_OP = 'INSERT' and existing_owner = new.manager_user_id and existing_workspace = new.workspace_id then return new; end if;
  if (select count(*) from public.manager_property_records where workspace_id = new.workspace_id) >= 10 then
    raise exception 'This workspace has reached 10 property records, including drafts.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_property_workspace() from public, anon, authenticated;
drop trigger if exists property_workspace_limit on public.manager_property_records;
create trigger property_workspace_limit before insert or update of manager_user_id, workspace_id
on public.manager_property_records for each row execute function public.enforce_property_workspace();
