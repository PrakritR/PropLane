-- Managed view-only lock, v3 (lock-review fixes). Supersedes the rule in 20261019120000.
--
-- 1. The admin escape no longer reads the LEGACY `profiles.role` column. That column is the role the
--    account was CREATED as and multi-role accounts keep it forever (AGENTS.md: authorize off
--    `profile_roles`), so a managed owner whose account began as admin - or whose admin row was since
--    revoked - kept full write past the lock. Admin is now `profile_roles.role = 'admin'` or the
--    always-admin ops address, nothing else.
--
-- 2. "Self-paid" is CURRENT, not "ever": the row's own `tier` must be pro|business now, alongside a
--    Stripe subscription id or an Apple anchor. Every cancellation path writes tier `free` and clears
--    the id (`customer.subscription.deleted` and the Stripe reconciler; RevenueCat expiry / refund via
--    `downgradeAppleManagerPurchase`), so a client who buys Pro for one month and cancels is locked
--    again. No subscription-status column is needed here, and none is invented.
--
-- Idempotent (create or replace); additive. Mirrors src/lib/auth/managed-read-only.server.ts.

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
        and lower(btrim(coalesce(p.email, ''))) = 'founders@axis-seattle-housing.com'
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
