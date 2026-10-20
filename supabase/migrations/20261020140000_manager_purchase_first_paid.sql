-- "Self-paid" requires money that actually moved (security review, Oct 20).
--
-- 20261020130000 made a Stripe subscription self-paid when its status is active|past_due. Neither proves a
-- payment: a trial that rolls to `past_due` when the first card charge fails has paid nothing, and an `active`
-- subscription on a 100%-off promotion bills $0 for ever. Both unlocked a PropLane Service client's workspace.
--
-- `manager_purchases.first_paid_at` is stamped (only while null) by the Stripe `invoice.paid` webhook when
-- amount_paid > 0, by checkout fulfillment when the session collected money (amount_total > 0, payment_status
-- paid), and by the daily plan reconciler from the subscription's paid invoices. Self-paid becomes:
--
--   tier pro|business AND (an Apple anchor OR (a Stripe subscription id AND status active|past_due AND first_paid_at set))
--
-- Backfilled null, which does NOT count: an existing Stripe subscriber is locked until the next reconcile stamps
-- the column from Stripe's paid invoices (fail closed). Apple is unaffected.
--
-- Idempotent (add column if not exists + create or replace); additive. Supersedes the rule in 20261020130000.
-- Mirrors src/lib/auth/managed-read-only.server.ts. Grants unchanged.

alter table public.manager_purchases
  add column if not exists first_paid_at timestamptz;

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
          and mp.first_paid_at is not null
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
