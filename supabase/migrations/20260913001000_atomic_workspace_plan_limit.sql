-- A named workspace must check the plan-derived cap and insert under one
-- owner lock. The route derives both owner and cap from authenticated context.
create or replace function public.create_portal_workspace_with_limit(
  p_owner uuid,
  p_name text,
  p_limit integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_count integer;
  created_workspace_id uuid;
begin
  if p_owner is null then
    raise exception 'Workspace owner is required.' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'Workspace limit must be between 1 and 10.' using errcode = '22023';
  end if;
  if p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 80 then
    raise exception 'Workspace name must be between 1 and 80 characters.' using errcode = '22023';
  end if;

  -- This is deliberately byte-for-byte the lock key used by the existing
  -- workspace trigger and default-workspace helper.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workspace-owner:' || p_owner::text, 0)
  );

  -- The first named-workspace request has always reserved the default first.
  -- Count it before considering the requested workspace.
  if not exists (
    select 1
    from public.portal_workspaces
    where owner_user_id = p_owner and is_default
  ) then
    insert into public.portal_workspaces (owner_user_id, name, is_default)
    values (p_owner, 'My workspace', true);
  end if;

  select count(*)::integer
  into workspace_count
  from public.portal_workspaces
  where owner_user_id = p_owner;

  if workspace_count >= p_limit then
    return null;
  end if;

  insert into public.portal_workspaces (owner_user_id, name)
  values (p_owner, pg_catalog.btrim(p_name))
  returning id into created_workspace_id;
  return created_workspace_id;
end;
$$;

revoke all on function public.create_portal_workspace_with_limit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.create_portal_workspace_with_limit(uuid, text, integer) to service_role;
