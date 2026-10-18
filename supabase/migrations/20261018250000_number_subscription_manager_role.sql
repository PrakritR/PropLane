-- PropLane Number for a MANAGER (number model, captain Oct 18): a Free manager can subscribe to a
-- personalized work number alone ($5/month, the same Stripe Price as vendors and residents); Pro and
-- Business include one. Additive and idempotent: widens the owner_role check on number_subscriptions
-- and the webhook's apply function to accept 'manager'. No new table, no grant change.

alter table public.number_subscriptions drop constraint if exists number_subscriptions_owner_role_check;
alter table public.number_subscriptions
  add constraint number_subscriptions_owner_role_check check (owner_role in ('vendor', 'resident', 'manager'));

create or replace function public.apply_number_subscription_event(
  p_owner uuid,
  p_role text,
  p_customer text,
  p_subscription text,
  p_status text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_at timestamptz
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.number_subscriptions%rowtype;
begin
  if p_owner is null or p_customer is null or length(p_customer) < 1 or p_subscription is null
    or length(p_subscription) < 1 or p_event_at is null
    or p_role not in ('vendor', 'resident', 'manager')
    or p_status not in ('active', 'past_due', 'canceled', 'incomplete') then
    raise exception 'Invalid number subscription event';
  end if;
  insert into public.number_subscriptions(owner_user_id, owner_role, stripe_customer_id, status)
    values (p_owner, p_role, p_customer, 'incomplete')
    on conflict (owner_user_id) do nothing;
  select * into cur from public.number_subscriptions where owner_user_id = p_owner for update;
  if cur.stripe_customer_id is not null and cur.stripe_customer_id <> p_customer then
    return 'customer_mismatch';
  end if;
  -- A live subscription is never replaced, and a stale subscription's events never touch it.
  if cur.stripe_subscription_id is not null and cur.stripe_subscription_id <> p_subscription
    and cur.status in ('active', 'past_due') then
    return 'other_subscription';
  end if;
  if cur.last_event_at is not null and cur.last_event_at > p_event_at then
    return 'stale';
  end if;
  update public.number_subscriptions set
    stripe_customer_id = p_customer,
    stripe_subscription_id = p_subscription,
    status = p_status,
    current_period_end = coalesce(p_period_end, current_period_end),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    last_event_at = p_event_at,
    updated_at = now()
    where owner_user_id = p_owner;
  return 'applied';
end $$;

revoke all on function public.apply_number_subscription_event(uuid, text, text, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_number_subscription_event(uuid, text, text, text, text, timestamptz, boolean, timestamptz) to service_role;
