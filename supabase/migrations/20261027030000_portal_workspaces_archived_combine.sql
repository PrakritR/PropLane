-- Admin > Accounts > Managers > "Managed by PropLane" > Combine all into one.
--
-- An owner with several workspaces can have their houses gathered into ONE PropLane-managed workspace. The emptied
-- workspaces are not deleted: they are ARCHIVED (reversible - clear archived_at), and every workspace list leaves an
-- archived one out. Additive and idempotent.
--
--   * portal_workspaces.archived_at - null for every workspace that exists today.
--   * combine_portal_workspaces - the one writer of the move. In ONE transaction it changes only the house -> workspace
--     link (manager_property_records.workspace_id) of the source workspaces' houses to the target, then archives the
--     emptied sources. It never touches an owner, lease, charge or application, and a failure anywhere rolls the whole
--     thing back, so nothing is half-moved. service_role only; the app re-derives and audits before calling it.

alter table public.portal_workspaces add column if not exists archived_at timestamptz;
create index if not exists portal_workspaces_archived_idx
  on public.portal_workspaces(owner_user_id) where archived_at is not null;

create or replace function public.combine_portal_workspaces(
  p_owner uuid,
  p_target uuid,
  p_sources uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected integer;
  v_found integer;
  v_moved uuid[];
  v_archived uuid[];
  v_kept uuid[];
begin
  if p_owner is null or p_target is null or p_sources is null or pg_catalog.cardinality(p_sources) = 0 then
    raise exception 'Owner, target and sources are required.' using errcode = '22023';
  end if;
  if p_target = any (p_sources) then
    raise exception 'The target cannot also be a source.' using errcode = '22023';
  end if;

  -- The same owner lock workspace creation and house moves take, so this cannot interleave with them.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-owner:' || p_owner::text, 0));

  perform 1 from public.portal_workspaces
    where id = p_target and owner_user_id = p_owner and archived_at is null
    for update;
  if not found then
    raise exception 'The target workspace is not an active workspace of this owner.' using errcode = '23514';
  end if;

  v_expected := pg_catalog.cardinality(p_sources);
  select pg_catalog.count(*) into v_found from public.portal_workspaces
    where id = any (p_sources) and owner_user_id = p_owner and archived_at is null and is_service = false;
  if v_found <> v_expected then
    raise exception 'Every source must be an active, unmanaged workspace of this owner.' using errcode = '23514';
  end if;
  perform 1 from public.portal_workspaces where id = any (p_sources) for update;

  -- Only the link field moves. The enforce_property_workspace trigger re-checks that the owner matches.
  with moved as (
    update public.manager_property_records
       set workspace_id = p_target
     where manager_user_id = p_owner and workspace_id = any (p_sources)
    returning id
  )
  select coalesce(pg_catalog.array_agg(id), '{}'::uuid[]) into v_moved from moved;

  -- An owner's default workspace is where a house with no workspace lands, so it stays listed (emptied, not archived).
  with archived as (
    update public.portal_workspaces
       set archived_at = pg_catalog.now()
     where id = any (p_sources) and owner_user_id = p_owner and is_default = false
    returning id
  )
  select coalesce(pg_catalog.array_agg(id), '{}'::uuid[]) into v_archived from archived;

  select coalesce(pg_catalog.array_agg(id), '{}'::uuid[]) into v_kept from public.portal_workspaces
    where id = any (p_sources) and archived_at is null;

  return pg_catalog.jsonb_build_object('moved', v_moved, 'archived', v_archived, 'kept', v_kept);
end;
$$;

revoke all on function public.combine_portal_workspaces(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.combine_portal_workspaces(uuid, uuid, uuid[]) to service_role;
