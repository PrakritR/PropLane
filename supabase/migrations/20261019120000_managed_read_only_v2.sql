-- Managed view-only lock, v2 (security review fixes). Supersedes the rule in 20261019100000.
--
-- H2: "self-paid" no longer counts free-tier rows. /api/manager/signup-intent and
-- /api/stripe/checkout-portal write billing monthly|annual for tier free BEFORE any payment, and
-- an email match was satisfied by unauthenticated inserts. Self-paid is now: a manager_purchases
-- row matched by user_id ONLY, tier pro|business, with a non-empty stripe_subscription_id or a
-- non-empty apple_original_transaction_id. manager_purchases has no subscription-status column,
-- so no active/trialing check is possible here (a canceled Stripe sub keeps its id on the row).
--
-- H1: the middleware lock is ACCOUNT-WIDE for an owner of a locked service workspace. The new
-- managed_read_only_owner_locked() answers that; property_owner team seats do NOT fire it (they
-- only appear in managed_read_only_workspace_ids(), which drives the UI readOnly flag and tools).
--
-- Idempotent; additive. Mirrors src/lib/auth/managed-read-only.server.ts.

-- Service workspaces `uid` owns that are locked for them (internal helper, no client grant).
create or replace function public.managed_read_only_owned_locked_ids(uid uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  is_admin boolean;
  is_service_owner boolean;
  self_paid boolean;
begin
  if uid is null then
    return '{}';
  end if;

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
    where mp.user_id = uid
      and lower(btrim(coalesce(mp.tier, ''))) in ('pro', 'business')
      and (
        btrim(coalesce(mp.stripe_subscription_id, '')) <> ''
        or btrim(coalesce(mp.apple_original_transaction_id, '')) <> ''
      )
  ) into self_paid;

  if is_admin or is_service_owner or self_paid then
    return '{}';
  end if;

  return coalesce((
    select array_agg(w.id order by w.id)
    from public.portal_workspaces w
    where w.owner_user_id = uid and w.is_service
  ), '{}');
end;
$$;

revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated;

-- Which workspaces are view-only for auth.uid() (UI readOnly flag + tool layer).
create or replace function public.managed_read_only_workspace_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
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

-- The middleware decision: does auth.uid() OWN a locked service workspace? Account-wide, so a
-- forged or other-workspace cookie changes nothing. Seats (property_owner) never count.
create or replace function public.managed_read_only_owner_locked()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(cardinality(public.managed_read_only_owned_locked_ids(auth.uid())), 0) > 0;
$$;

revoke all on function public.managed_read_only_owner_locked() from public, anon;
grant execute on function public.managed_read_only_owner_locked() to authenticated;
