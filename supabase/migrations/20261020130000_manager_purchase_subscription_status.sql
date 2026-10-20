-- A Stripe subscription that is still TRIALING is not a self-paid plan (captain, Oct 20).
--
-- Manager Pro / Business Checkout is created with `trial_period_days`, and fulfillment records a `trialing`
-- subscription as tier pro|business with its subscription id. The managed view-only lock treated that row as
-- self-paid, so a PropLane Service client who started the 14-day card-on-file trial and had paid nothing
-- unlocked full write for the trial window: the account-wide middleware 403, the tool-layer write refusal and
-- the inbox restriction all switched off.
--
-- `manager_purchases` now carries the subscription's own status, written by the subscription webhook and the
-- plan reconciler (`reconcileManagerPurchaseWithStripe`). Self-paid is:
--
--   tier pro|business AND (an Apple anchor OR (a Stripe subscription id AND its status is active|past_due))
--
-- `past_due` counts: the client has paid before and Stripe is retrying, which is a billing problem, not a
-- revoked plan. Backfilled null, which does NOT count - an existing Stripe subscriber is locked until the
-- next reconcile writes the status (it runs on every manager page load), and the fail-closed direction is the
-- right one for a lock. Apple is unaffected: RevenueCat expiry / refund writes tier free.
--
-- Idempotent (add column if not exists + create or replace); additive. Supersedes the rule in 20261020100000.
-- Mirrors src/lib/auth/managed-read-only.server.ts.

alter table public.manager_purchases
  add column if not exists subscription_status text;

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
        btrim(coalesce(mp.apple_original_transaction_id, '')) <> ''
        or (
          btrim(coalesce(mp.stripe_subscription_id, '')) <> ''
          and lower(btrim(coalesce(mp.subscription_status, ''))) in ('active', 'past_due')
        )
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
