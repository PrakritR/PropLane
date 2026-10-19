-- Managed (PropLane Service) workspaces are VIEW-ONLY for their client.
--
-- A client whose workspace is attached to PropLane Service (portal_workspaces.is_service)
-- stays the owner (owner_user_id) and sees the manager portal read-only unless she buys a
-- plan herself. PropLane staff keep full write: the seated service admin member, the
-- platform service owner (platform_service_settings.owner_user_id) and platform admins.
--
-- managed_read_only_workspace_ids() answers, for auth.uid(), which workspaces are locked:
--   * a service workspace the caller OWNS, unless the caller is a platform admin, the
--     platform service owner, or holds a SELF-PAID plan. Self-paid is an allowlist:
--     a non-empty stripe_subscription_id, billing monthly|annual, or an Apple anchor.
--     Admin grants, trials and waivers/promos are NOT self-paid.
--   * the workspace of an accepted `property_owner` team seat (that role is a view-only seat).
-- It mirrors src/lib/auth/managed-read-only.server.ts (hasSelfPaidPlan). Admin detection
-- mirrors filterAdminUserIds: profile_roles admin, legacy profiles.role admin, or the
-- primary-admin email. Idempotent; additive.

create or replace function public.managed_read_only_workspace_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  uemail text;
  locked uuid[] := '{}';
  is_admin boolean;
  is_service_owner boolean;
  self_paid boolean;
begin
  if uid is null then
    return locked;
  end if;

  select lower(btrim(coalesce(p.email, ''))) into uemail from public.profiles p where p.id = uid;
  uemail := coalesce(uemail, '');

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

  select
    exists (select 1 from public.profile_roles r where r.user_id = uid and r.role = 'admin')
    or exists (
      select 1 from public.profiles p
      where p.id = uid
        and (lower(btrim(coalesce(p.role, ''))) = 'admin'
             or lower(btrim(coalesce(p.email, ''))) = 'founders@axis-seattle-housing.com')
    )
  into is_admin;

  select exists (select 1 from public.platform_service_settings s where s.owner_user_id = uid)
  into is_service_owner;

  select exists (
    select 1 from public.manager_purchases mp
    where (mp.user_id = uid or (uemail <> '' and lower(btrim(coalesce(mp.email, ''))) = uemail))
      and (
        btrim(coalesce(mp.stripe_subscription_id, '')) <> ''
        or lower(btrim(coalesce(mp.billing, ''))) in ('monthly', 'annual')
        or btrim(coalesce(mp.apple_original_transaction_id, '')) <> ''
      )
  ) into self_paid;

  if not is_admin and not is_service_owner and not self_paid then
    locked := locked || coalesce((
      select array_agg(w.id)
      from public.portal_workspaces w
      where w.owner_user_id = uid and w.is_service
    ), '{}');
  end if;

  return coalesce((select array_agg(distinct x order by x) from unnest(locked) as x), '{}');
end;
$$;

revoke all on function public.managed_read_only_workspace_ids() from public, anon;
grant execute on function public.managed_read_only_workspace_ids() to authenticated;
