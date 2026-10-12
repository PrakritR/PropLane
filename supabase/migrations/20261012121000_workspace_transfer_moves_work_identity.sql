-- Workspace comms isolation (Oct 12 2026), claude-2-branch-12.
--
-- 1. Ownership transfer moves the work identity. The function below is
--    20260921000000_workspace_ownership_transfer.sql, byte for byte, plus a
--    new step 5 that sets `manager_user_id = p_to` on the workspace's
--    `manager_sms_numbers` and `manager_assistant_emails` rows. Grants kept.
-- 2. One live work number per workspace. `manager_sms_numbers_workspace_uniq`
--    was unique on `workspace_id` across EVERY row, so a released number kept
--    blocking a new one for the same workspace. It becomes unique among rows
--    that are not released (`released_at is null`). The e-mail twin
--    (`manager_assistant_emails_workspace_active_uniq`, `where provision_state
--    = 'active'`) already has that shape and is left alone.
--    Code that upserted `on conflict (workspace_id)` cannot infer a partial
--    index; `ensureManagerNumberRecord` now inserts instead.
-- Additive and idempotent.

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
  v_moved_numbers text[];
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

  -- 5. The work identity follows the workspace. A workspace's work number and
  --    work email are owned by the workspace's OWNER (`manager_user_id`), and
  --    every send/inbound path re-derives the owner from that column, so a
  --    transfer that left them behind kept texting the new owner's residents
  --    from the old owner's line (and billing it to them). Every row of the
  --    workspace moves, released ones included, so retained history keeps
  --    resolving to the same owner. `workspace_work_numbers` is keyed by
  --    workspace and number, no owner column: nothing to move there, but a
  --    hold that would now cross owners is dropped (a line shared between
  --    one person's workspaces must not survive the workspace changing hands).
  --    The old owner's `profiles.sms_from_number` cache (their DEFAULT
  --    workspace's line) is cleared when it names a number that just left.
  select coalesce(array_agg(phone_number) filter (where phone_number is not null), '{}')
    into v_moved_numbers
  from public.manager_sms_numbers
  where workspace_id = p_workspace and manager_user_id = p_from;

  update public.manager_sms_numbers
  set manager_user_id = p_to, updated_at = now()
  where workspace_id = p_workspace and manager_user_id = p_from;

  update public.manager_assistant_emails
  set manager_user_id = p_to
  where workspace_id = p_workspace and manager_user_id = p_from;

  -- Holds that now cross owners: the transferred workspace holding a line the
  -- old owner still owns, and the old owner's other workspaces holding a line
  -- that just left them.
  delete from public.workspace_work_numbers h
  using public.manager_sms_numbers n
  where h.number_id = n.id
    and h.workspace_id = p_workspace
    and n.manager_user_id <> p_to;
  delete from public.workspace_work_numbers h
  using public.manager_sms_numbers n, public.portal_workspaces w
  where h.number_id = n.id
    and w.id = h.workspace_id
    and n.workspace_id = p_workspace
    and w.owner_user_id = p_from
    and h.workspace_id <> p_workspace;

  if array_length(v_moved_numbers, 1) is not null then
    update public.profiles
    set sms_from_number = null, updated_at = now()
    where id = p_from and sms_from_number = any(v_moved_numbers);
  end if;

  perform set_config('app.workspace_ownership_transfer', 'off', true);

  return jsonb_build_object('houses', v_house_count, 'members', v_member_count);
end;
$$;

revoke all on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------- numbers --
drop index if exists public.manager_sms_numbers_workspace_uniq;
create unique index if not exists manager_sms_numbers_workspace_uniq
  on public.manager_sms_numbers (workspace_id) where released_at is null;
