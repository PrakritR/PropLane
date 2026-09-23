-- Plans limit residents + workspaces only. Drop the 10 property-records-per-
-- workspace hard cap. Hard-cap work numbers at 1 per workspace (was 2).

create or replace function public.enforce_property_workspace()
returns trigger language plpgsql security definer set search_path = public as $$
declare workspace_owner uuid; existing_workspace uuid; existing_owner uuid;
begin
  if coalesce(current_setting('app.workspace_ownership_transfer', true), '') = 'on' then
    return new;
  end if;
  if new.manager_user_id is null then new.workspace_id := null; return new; end if;
  if TG_OP = 'INSERT' then
    select workspace_id, manager_user_id into existing_workspace, existing_owner
      from public.manager_property_records where id = new.id;
    if existing_owner = new.manager_user_id and new.workspace_id is null then
      new.workspace_id := existing_workspace;
    end if;
  end if;
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
  -- Property-record count cap removed (PLAN-0923): plans no longer limit
  -- properties per workspace.
  return new;
end;
$$;

create or replace function public.enforce_workspace_work_number_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.workspace_work_numbers where workspace_id = new.workspace_id) >= 1 then
    raise exception 'A workspace can hold at most 1 work number.' using errcode = '23514';
  end if;
  return new;
end;
$$;
