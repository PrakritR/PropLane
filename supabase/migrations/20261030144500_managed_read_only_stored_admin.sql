-- Admin authority requires an explicit stored role grant. No data is changed.
create or replace function public.managed_read_only_owned_locked_ids(uid uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
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
