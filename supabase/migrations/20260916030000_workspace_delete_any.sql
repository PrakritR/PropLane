-- Every owned workspace can be deleted, including the default one, and a
-- named create never seeds a second workspace beside it.
--
-- Before this file, `create_portal_workspace_with_limit` reserved a hidden
-- "My workspace" (is_default) before inserting the requested one, so a fresh
-- account's first "+ Add workspace" produced two cards. Now the first named
-- workspace simply IS the default. The database trigger that gives an unplaced
-- house a workspace (`ensure_default_portal_workspace`) is unchanged, so an
-- account with zero workspaces still gets one the moment it adds a house.
--
-- `delete_portal_workspace` is the one delete path: under the same owner
-- advisory lock as the create routine and the limit trigger it optionally
-- moves the workspace's houses to another workspace the same owner holds (the
-- `property_workspace_limit` trigger still enforces owner parity and the
-- 10-record cap), deletes the row (the FK RESTRICT still refuses a delete with
-- houses left behind), and hands `is_default` to the oldest remaining owned
-- workspace so account-level rows keep exactly one home.

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

  select count(*)::integer
  into workspace_count
  from public.portal_workspaces
  where owner_user_id = p_owner;

  if workspace_count >= p_limit then
    return null;
  end if;

  -- The first workspace an owner names is the default. Nothing is seeded
  -- beside it.
  insert into public.portal_workspaces (owner_user_id, name, is_default)
  values (
    p_owner,
    pg_catalog.btrim(p_name),
    not exists (
      select 1
      from public.portal_workspaces
      where owner_user_id = p_owner and is_default
    )
  )
  returning id into created_workspace_id;
  return created_workspace_id;
end;
$$;

revoke all on function public.create_portal_workspace_with_limit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.create_portal_workspace_with_limit(uuid, text, integer) to service_role;

create or replace function public.delete_portal_workspace(
  p_owner uuid,
  p_id uuid,
  p_move_to uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_default boolean;
  destination_owner uuid;
begin
  if p_owner is null or p_id is null then
    raise exception 'Workspace owner and id are required.' using errcode = '22023';
  end if;
  if p_move_to is not null and p_move_to = p_id then
    raise exception 'Houses cannot move into the workspace being deleted.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workspace-owner:' || p_owner::text, 0)
  );

  select is_default into was_default
  from public.portal_workspaces
  where id = p_id and owner_user_id = p_owner
  for update;
  if not found then
    return false;
  end if;

  if p_move_to is not null then
    -- The destination must be this owner's too; ids in a request are never
    -- authorization.
    select owner_user_id into destination_owner
    from public.portal_workspaces
    where id = p_move_to
    for update;
    if destination_owner is distinct from p_owner then
      raise exception 'The destination workspace must belong to the same owner.' using errcode = '23514';
    end if;
    -- The BEFORE ROW property trigger runs for every house and sees the ones
    -- already moved by this statement, so the destination's 10-record cap is
    -- arbitrated per house; one refusal aborts the whole delete.
    update public.manager_property_records
    set workspace_id = p_move_to
    where workspace_id = p_id and manager_user_id = p_owner;
  end if;

  -- FK RESTRICT on manager_property_records.workspace_id refuses this while
  -- any house remains (23503), which the route maps to "move them first".
  delete from public.portal_workspaces
  where id = p_id and owner_user_id = p_owner;

  if was_default then
    update public.portal_workspaces
    set is_default = true
    where id = (
      select id
      from public.portal_workspaces
      where owner_user_id = p_owner
      order by created_at, id
      limit 1
    );
  end if;

  return true;
end;
$$;

revoke all on function public.delete_portal_workspace(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_portal_workspace(uuid, uuid, uuid) to service_role;
