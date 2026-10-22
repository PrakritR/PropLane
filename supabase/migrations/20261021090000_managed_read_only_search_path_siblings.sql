-- Pin pg_temp last on the other two SECURITY DEFINER functions of the managed read-only family (security review, Oct 21).
--
-- 20261020190100 did this for managed_read_only_owned_locked_ids. Its two siblings, defined in
-- 20261019120000 with `set search_path = public`, are still the latest definitions and both are
-- `grant execute ... to authenticated` - so the shadowing that file describes applies to them more
-- directly: without pg_temp named explicitly Postgres searches the session's temporary schema FIRST
-- for relations, and a caller who can create a temp table named like one the body reads could shadow
-- it inside a SECURITY DEFINER function. Naming pg_temp last puts it behind public.
--
-- Bodies are identical to 20261019120000 and the grants match it. Idempotent (create or replace,
-- drop policy-free, no data touched); safe to re-run.

create or replace function public.managed_read_only_workspace_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  locked uuid[] := '{}';
begin
  if uid is null then
    return locked;
  end if;

  -- Retired property_owner seats are view-only on the workspace they were seated in.
  locked := coalesce((
    select array_agg(distinct w.id)
    from public.account_link_invites l
    join public.portal_workspaces w
      on (l.workspace_id is not null and w.id = l.workspace_id)
      or (l.workspace_id is null and w.owner_user_id = l.inviter_user_id)
    where l.invitee_user_id = uid
      and l.status = 'accepted'
      and l.team_role = 'property_owner'
  ), '{}');

  locked := locked || public.managed_read_only_owned_locked_ids(uid);

  return coalesce((select array_agg(distinct x order by x) from unnest(locked) as x), '{}');
end;
$$;

revoke all on function public.managed_read_only_workspace_ids() from public, anon;
grant execute on function public.managed_read_only_workspace_ids() to authenticated;

create or replace function public.managed_read_only_owner_locked()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(cardinality(public.managed_read_only_owned_locked_ids(auth.uid())), 0) > 0;
$$;

revoke all on function public.managed_read_only_owner_locked() from public, anon;
grant execute on function public.managed_read_only_owner_locked() to authenticated;
