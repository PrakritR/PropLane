-- Workspace memberships: one link per (owner, manager, workspace), a house
-- scope, and the Admin role.
--
-- Before this, a manager held ONE link to an owner across every workspace and
-- the Workspaces page guessed the card from where the link's houses sat. That
-- made the workspace a folder, not a boundary: a moved house carried its
-- members along, removing someone from one card cancelled their only link, and
-- a house added to a workspace reached nobody until each member was re-edited.
--
-- Now:
--   * `workspace_id` is filled for every row (the workspace holding its houses,
--     else the owner's default), and a row whose houses spanned several
--     workspaces is split so each workspace has its own row.
--   * `house_scope` is 'all' (every house in the workspace, kept current by
--     trigger) or 'selected' (the listed houses, pruned when one leaves).
--   * uniqueness is per workspace, so the same person can be Admin in one
--     workspace and Viewer in another.
--   * the on-by-default link rights (Add properties / Team) are parked in
--     `legacy_workspace_permissions`; rights now follow the role
--     (docs/agents/co-manager-access.md).
-- Idempotent and additive; safe to re-run.

alter table public.account_link_invites
  add column if not exists house_scope text not null default 'selected';
alter table public.account_link_invites
  drop constraint if exists account_link_invites_house_scope_check;
alter table public.account_link_invites
  add constraint account_link_invites_house_scope_check
  check (house_scope in ('all', 'selected'));
comment on column public.account_link_invites.house_scope is
  'all = every house in workspace_id, kept current by trigger; selected = assigned_property_ids as listed, pruned when a house leaves the workspace.';

alter table public.account_link_invites
  add column if not exists legacy_workspace_permissions jsonb not null default '{}'::jsonb;
comment on column public.account_link_invites.legacy_workspace_permissions is
  'The on-by-default Add properties / Team flags a link held before rights followed the role. Shown to the owner as a review notice; cleared on the next edit. Never authorization.';

alter table public.manager_invite_links
  add column if not exists house_scope text not null default 'selected';
alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_house_scope_check;
alter table public.manager_invite_links
  add constraint manager_invite_links_house_scope_check
  check (house_scope in ('all', 'selected'));

-- Admin joins the role catalogue on both tables.
alter table public.account_link_invites
  drop constraint if exists account_link_invites_team_role_check;
alter table public.account_link_invites
  add constraint account_link_invites_team_role_check
  check (
    team_role is null
    or team_role in ('viewer', 'leasing', 'property_manager', 'bookkeeper', 'maintenance', 'admin', 'full', 'custom')
  );
alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_team_role_check;
alter table public.manager_invite_links
  add constraint manager_invite_links_team_role_check
  check (
    team_role is null
    or team_role in ('viewer', 'leasing', 'property_manager', 'bookkeeper', 'maintenance', 'admin', 'full', 'custom')
  );

-- Park the legacy link rights. Rows already stamped Admin / Full access keep
-- theirs by role; every other row's flags become a review notice.
update public.account_link_invites
set legacy_workspace_permissions = workspace_permissions,
    workspace_permissions = '{}'::jsonb
where workspace_permissions <> '{}'::jsonb
  and coalesce(team_role, '') not in ('admin', 'full')
  and legacy_workspace_permissions = '{}'::jsonb;

-- Pin every row to a workspace, splitting a row whose houses sit in several.
do $$
declare
  link record;
  ws record;
  first_ws uuid;
  ids jsonb;
  perms jsonb;
begin
  for link in
    select i.id, i.inviter_user_id, i.assigned_property_ids, i.property_co_manager_permissions, i.workspace_id
    from public.account_link_invites i
    where i.tab_kind = 'manager'
  loop
    first_ws := link.workspace_id;
    -- Every workspace that holds one of this row's houses, owner-scoped.
    for ws in
      select p.workspace_id, jsonb_agg(to_jsonb(p.id)) as house_ids
      from public.manager_property_records p
      where p.manager_user_id = link.inviter_user_id
        and p.workspace_id is not null
        and link.assigned_property_ids ? p.id
      group by p.workspace_id
      order by p.workspace_id = link.workspace_id desc, min(p.created_at)
    loop
      if first_ws is null then
        first_ws := ws.workspace_id;
      end if;
      if ws.workspace_id = first_ws then
        continue;
      end if;
      -- A second workspace: give it its own row with only its houses.
      ids := ws.house_ids;
      perms := '{}'::jsonb;
      if jsonb_typeof(link.property_co_manager_permissions) = 'object' then
        select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into perms
        from jsonb_each(link.property_co_manager_permissions)
        where ids ? key;
      end if;
      insert into public.account_link_invites (
        inviter_user_id, invitee_user_id, tab_kind, inviter_axis_id, invitee_axis_id,
        inviter_display_name, invitee_display_name, assigned_property_ids,
        payout_percent_for_manager, status, created_at, responded_at,
        co_manager_permissions, property_co_manager_permissions, expires_at,
        invitee_plan_inherited, workspace_id, workspace_permissions, team_role,
        house_scope, legacy_workspace_permissions
      )
      select i.inviter_user_id, i.invitee_user_id, i.tab_kind, i.inviter_axis_id, i.invitee_axis_id,
        i.inviter_display_name, i.invitee_display_name, ids,
        i.payout_percent_for_manager, i.status, i.created_at, i.responded_at,
        i.co_manager_permissions, perms, i.expires_at,
        i.invitee_plan_inherited, ws.workspace_id, '{}'::jsonb, i.team_role,
        'selected', i.legacy_workspace_permissions
      from public.account_link_invites i
      where i.id = link.id
        and not exists (
          select 1 from public.account_link_invites d
          where d.tab_kind = i.tab_kind
            and d.workspace_id = ws.workspace_id
            and least(d.inviter_user_id, d.invitee_user_id) = least(i.inviter_user_id, i.invitee_user_id)
            and greatest(d.inviter_user_id, d.invitee_user_id) = greatest(i.inviter_user_id, i.invitee_user_id)
            and d.status in ('pending', 'accepted')
        );
    end loop;

    if first_ws is null then
      first_ws := public.ensure_default_portal_workspace(link.inviter_user_id);
    end if;

    -- The original row keeps the first workspace and only the houses in it.
    select coalesce(jsonb_agg(to_jsonb(p.id)), '[]'::jsonb) into ids
    from public.manager_property_records p
    where p.manager_user_id = link.inviter_user_id
      and p.workspace_id = first_ws
      and link.assigned_property_ids ? p.id;
    perms := '{}'::jsonb;
    if jsonb_typeof(link.property_co_manager_permissions) = 'object' then
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into perms
      from jsonb_each(link.property_co_manager_permissions)
      where ids ? key;
    end if;
    update public.account_link_invites
    set workspace_id = first_ws,
        assigned_property_ids = case when jsonb_array_length(ids) > 0 or link.assigned_property_ids = '[]'::jsonb then ids else assigned_property_ids end,
        property_co_manager_permissions = case when jsonb_array_length(ids) > 0 or link.assigned_property_ids = '[]'::jsonb then perms else property_co_manager_permissions end
    where id = link.id;
  end loop;
end $$;

-- Uniqueness is per workspace now. A null workspace (a row written by code
-- that predates this migration, before the backfill runs on it) still counts
-- once per pair, through the nil uuid.
drop index if exists public.account_link_invites_unique_active_pair;
create unique index if not exists account_link_invites_unique_active_pair_ws
  on public.account_link_invites (
    tab_kind,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    least(inviter_user_id, invitee_user_id),
    greatest(inviter_user_id, invitee_user_id)
  )
  where status in ('pending', 'accepted');

drop index if exists public.account_link_invites_unique_pending;
create unique index if not exists account_link_invites_unique_pending_ws
  on public.account_link_invites (
    inviter_user_id, invitee_user_id, tab_kind,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'pending';

drop index if exists public.account_link_invites_one_open_pending;
create unique index if not exists account_link_invites_one_open_pending_ws
  on public.account_link_invites (
    inviter_user_id, tab_kind,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'pending' and invitee_user_id is null;

create index if not exists account_link_invites_workspace_scope_idx
  on public.account_link_invites (workspace_id, house_scope)
  where status in ('pending', 'accepted');

-- "All houses" rows always list the workspace's current houses. Computed on
-- the row's own write, and re-triggered from the property side below, so a
-- reader never has to know about scopes: assigned_property_ids is the truth.
create or replace function public.sync_workspace_membership_houses()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.house_scope = 'all' and new.workspace_id is not null then
    select coalesce(jsonb_agg(to_jsonb(p.id) order by p.created_at), '[]'::jsonb)
      into new.assigned_property_ids
    from public.manager_property_records p
    where p.workspace_id = new.workspace_id
      and p.manager_user_id = new.inviter_user_id;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_workspace_membership_houses() from public, anon, authenticated;
drop trigger if exists account_link_invites_sync_houses on public.account_link_invites;
create trigger account_link_invites_sync_houses
before insert or update of house_scope, workspace_id, assigned_property_ids, status
on public.account_link_invites for each row execute function public.sync_workspace_membership_houses();

-- A house that joins, leaves, or changes hands updates the memberships of the
-- workspaces it touched: 'all' rows are recomputed, 'selected' rows in the
-- workspace it LEFT lose it (and its permission entry) — the workspace decides.
create or replace function public.propagate_workspace_houses_to_memberships()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  left_ws uuid;
  left_owner uuid;
  joined_ws uuid;
  joined_owner uuid;
begin
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
    -- 'all' rows recompute their list (the BEFORE trigger) and drop the
    -- house's own map entry so a later re-join starts from the role stamp.
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
revoke all on function public.propagate_workspace_houses_to_memberships() from public, anon, authenticated;
drop trigger if exists manager_property_records_propagate_memberships on public.manager_property_records;
create trigger manager_property_records_propagate_memberships
after insert or update of workspace_id, manager_user_id or delete
on public.manager_property_records for each row execute function public.propagate_workspace_houses_to_memberships();
