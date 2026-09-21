-- Workspace ownership transfer: hands the WHOLE workspace to an accepted
-- member in one atomic call. A workspace has exactly one owner
-- (`portal_workspaces.owner_user_id`); every house in it belongs to that
-- owner, so "transfer ownership" now means the workspace, never a picked
-- subset of its houses (the older per-house path,
-- `transfer_property_ownership`-backed `transferPropertyOwnership` in
-- src/lib/property-ownership-transfer.ts, stays for its own route).
--
-- Two existing triggers on `manager_property_records` react to a house's
-- `manager_user_id` changing and would fight this call if left alone:
--   * `enforce_property_workspace` (20260911230000_portal_workspaces.sql)
--     resets `workspace_id` to null whenever `manager_user_id` changes, then
--     reassigns the house to the NEW owner's DEFAULT workspace — exactly the
--     "workspace_id stays put on the transferred workspace" behavior this
--     function needs.
--   * `propagate_workspace_houses_to_memberships`
--     (20260920180000_workspace_memberships.sql) treats each house's owner
--     change as "left workspace X / joined workspace Y" and prunes it out of
--     every OTHER member's 'selected'-scope row, and recomputes 'all'-scope
--     rows against the OLD owner — run mid-transfer (before this function
--     gets to step 4 and reassigns `inviter_user_id`), that would strip
--     every other member's house grants down to nothing, house by house, as
--     the loop in step 2/3 below moves each property.
-- Both are held off for the duration of this call with the session-local GUC
-- `app.workspace_ownership_transfer` (`set_config(..., true)`, so it is
-- local to the transaction and never leaks past it). This function owns
-- membership bookkeeping directly in step 4 instead of leaning on either
-- trigger.
create or replace function public.transfer_portal_workspace_ownership(
  p_workspace uuid,
  p_from uuid,
  p_to uuid,
  p_former_role text,
  p_former_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_name text;
  v_house_count integer;
  v_member_count integer;
  v_all_house_ids jsonb;
  v_former_perms_by_house jsonb;
  v_table text;
  -- Kept in the same order as `propertyTables` in
  -- src/lib/property-ownership-transfer.ts;
  -- tests/unit/workspace-ownership-transfer.test.ts asserts the two lists
  -- match.
  v_property_tables text[] := array[
    'manager_application_records',
    'portal_lease_pipeline_records',
    'portal_household_charge_records',
    'portal_recurring_rent_profile_records',
    'portal_work_order_records',
    'portal_schedule_records',
    'screening_orders',
    'cosigner_submission_records',
    'ledger_entries',
    'manager_expense_entries',
    'portal_scheduled_inbox_message_records',
    'payment_automation_settings'
  ];
  -- The two tables `transferPropertyOwnership` also rewrites by
  -- `assigned_property_id` (not `property_id`).
  v_assigned_property_id_tables text[] := array[
    'manager_application_records',
    'portal_work_order_records'
  ];
begin
  if p_workspace is null or p_from is null or p_to is null then
    raise exception 'Workspace, current owner and new owner are required.' using errcode = '22023';
  end if;
  if p_from = p_to then
    raise exception 'Choose a different member to transfer to.' using errcode = '22023';
  end if;

  select name into v_workspace_name
  from public.portal_workspaces
  where id = p_workspace and owner_user_id = p_from
  for update;
  if v_workspace_name is null then
    raise exception 'Workspace not found or you are not its owner.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.account_link_invites
    where inviter_user_id = p_from
      and invitee_user_id = p_to
      and workspace_id = p_workspace
      and status = 'accepted'
  ) then
    raise exception 'That person is not an accepted member of this workspace.' using errcode = 'P0002';
  end if;

  -- Held off for the rest of this transaction only; see header.
  perform set_config('app.workspace_ownership_transfer', 'on', true);

  -- 1. The workspace itself. `portal_workspace_limit` (existing trigger,
  --    20260911230000_portal_workspaces.sql) enforces the new owner's
  --    <=3-workspace cap on this update; let it raise rather than duplicate
  --    the check here.
  update public.portal_workspaces
  set owner_user_id = p_to, is_default = false
  where id = p_workspace;

  -- 2. Every house in the workspace follows. workspace_id is left untouched
  --    by this statement, and the guarded triggers above leave it alone too.
  update public.manager_property_records
  set manager_user_id = p_to, updated_at = now()
  where workspace_id = p_workspace and manager_user_id = p_from;

  select coalesce(jsonb_agg(to_jsonb(id) order by created_at), '[]'::jsonb), count(*)
    into v_all_house_ids, v_house_count
  from public.manager_property_records
  where workspace_id = p_workspace;

  -- 3. Every related table `transferPropertyOwnership` rewrites, across
  --    every house in the workspace at once.
  -- A table is rewritten only when it exists AND carries the join column —
  -- the TypeScript twin swallows "does not exist" errors per table, and three
  -- of these tables (screening_orders, cosigner_submission_records,
  -- portal_scheduled_inbox_message_records) key by manager only, with no
  -- property_id column at all.
  foreach v_table in array v_property_tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v_table and column_name = 'property_id'
    ) then
      execute format(
        'update public.%I set manager_user_id = $1 where manager_user_id = $2 and property_id in (select id from public.manager_property_records where workspace_id = $3)',
        v_table
      ) using p_to, p_from, p_workspace;
    end if;
  end loop;
  foreach v_table in array v_assigned_property_id_tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v_table and column_name = 'assigned_property_id'
    ) then
      execute format(
        'update public.%I set manager_user_id = $1 where manager_user_id = $2 and assigned_property_id in (select id from public.manager_property_records where workspace_id = $3)',
        v_table
      ) using p_to, p_from, p_workspace;
    end if;
  end loop;

  -- 4. Memberships.
  -- The new owner's own membership row (they were a member; now they own
  -- the workspace).
  delete from public.account_link_invites
  where workspace_id = p_workspace
    and inviter_user_id = p_from
    and invitee_user_id = p_to
    and status = 'accepted';

  -- Every remaining member of the workspace now answers to the new owner.
  -- `inviter_user_id` alone is not in `account_link_invites_sync_houses`'s
  -- watched column list, so this does not recompute anyone's
  -- `assigned_property_ids` — each member keeps exactly the houses they had.
  update public.account_link_invites
  set inviter_user_id = p_to
  where workspace_id = p_workspace
    and inviter_user_id = p_from
    and status in ('pending', 'accepted');
  get diagnostics v_member_count = row_count;

  -- The former owner becomes a member under whatever role they chose to
  -- keep, unless they chose "nothing".
  if p_former_role <> 'nothing' then
    select coalesce(jsonb_object_agg(id, p_former_permissions), '{}'::jsonb)
      into v_former_perms_by_house
    from public.manager_property_records
    where workspace_id = p_workspace;

    insert into public.account_link_invites (
      inviter_user_id, invitee_user_id, tab_kind,
      inviter_axis_id, invitee_axis_id,
      inviter_display_name, invitee_display_name,
      assigned_property_ids,
      property_co_manager_permissions, co_manager_permissions,
      workspace_id, house_scope, team_role,
      status, responded_at
    )
    select
      p_to, p_from, 'manager',
      coalesce(pt.manager_id, ''), coalesce(pf.manager_id, ''),
      coalesce(pt.full_name, pt.email, 'Manager'), coalesce(pf.full_name, pf.email, 'Manager'),
      v_all_house_ids,
      v_former_perms_by_house, p_former_permissions,
      p_workspace, 'all', p_former_role,
      'accepted', now()
    from public.profiles pt, public.profiles pf
    where pt.id = p_to and pf.id = p_from;
  end if;

  perform set_config('app.workspace_ownership_transfer', 'off', true);

  return jsonb_build_object('houses', v_house_count, 'members', v_member_count);
end;
$$;

revoke all on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) to service_role;

-- Guard `enforce_property_workspace` (20260911230000_portal_workspaces.sql):
-- during a workspace ownership transfer, a house's `manager_user_id` change
-- must NOT reset its `workspace_id` to null and reassign it to the new
-- owner's default workspace — the transferred workspace itself already
-- belongs to the new owner (step 1 above), so the house's `workspace_id`
-- must stay exactly where it is.
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
  if TG_OP = 'UPDATE' and new.workspace_id is not distinct from old.workspace_id then return new; end if;
  if TG_OP = 'INSERT' and existing_owner = new.manager_user_id and existing_workspace = new.workspace_id then return new; end if;
  if (select count(*) from public.manager_property_records where workspace_id = new.workspace_id) >= 10 then
    raise exception 'This workspace has reached 10 property records, including drafts.' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Guard `propagate_workspace_houses_to_memberships`
-- (20260920180000_workspace_memberships.sql): during a workspace ownership
-- transfer, a house's `manager_user_id` change is an internal admin change,
-- not the house leaving or joining a workspace, so no OTHER member's
-- `assigned_property_ids` should be touched by it. Step 4 above handles the
-- transfer's own membership bookkeeping directly.
create or replace function public.propagate_workspace_houses_to_memberships()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  left_ws uuid;
  left_owner uuid;
  joined_ws uuid;
  joined_owner uuid;
begin
  if TG_OP = 'UPDATE' and coalesce(current_setting('app.workspace_ownership_transfer', true), '') = 'on' then
    return null;
  end if;
  if TG_OP = 'DELETE' then
    left_ws := old.workspace_id; left_owner := old.manager_user_id;
  elsif TG_OP = 'INSERT' then
    joined_ws := new.workspace_id; joined_owner := new.manager_user_id;
  else
    if old.workspace_id is distinct from new.workspace_id or old.manager_user_id is distinct from new.manager_user_id then
      left_ws := old.workspace_id; left_owner := old.manager_user_id;
      joined_ws := new.workspace_id; joined_owner := new.manager_user_id;
    else
      return null;
    end if;
  end if;

  if left_ws is not null then
    update public.account_link_invites i
    set assigned_property_ids = i.assigned_property_ids - old.id,
        property_co_manager_permissions =
          case when jsonb_typeof(i.property_co_manager_permissions) = 'object'
               then i.property_co_manager_permissions - old.id
               else i.property_co_manager_permissions end
    where i.workspace_id = left_ws
      and i.inviter_user_id = left_owner
      and i.house_scope = 'selected'
      and i.status in ('pending', 'accepted')
      and i.assigned_property_ids ? old.id;
    update public.account_link_invites i
    set assigned_property_ids = i.assigned_property_ids,
        property_co_manager_permissions =
          case when jsonb_typeof(i.property_co_manager_permissions) = 'object'
               then i.property_co_manager_permissions - old.id
               else i.property_co_manager_permissions end
    where i.workspace_id = left_ws
      and i.inviter_user_id = left_owner
      and i.house_scope = 'all'
      and i.status in ('pending', 'accepted');
  end if;
  if joined_ws is not null then
    update public.account_link_invites i
    set assigned_property_ids = i.assigned_property_ids
    where i.workspace_id = joined_ws
      and i.inviter_user_id = joined_owner
      and i.house_scope = 'all'
      and i.status in ('pending', 'accepted');
  end if;
  return null;
end;
$$;
