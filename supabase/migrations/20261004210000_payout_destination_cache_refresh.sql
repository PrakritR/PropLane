-- Stripe is authoritative for payout destinations. A display-cache refresh
-- reserves an ordered token BEFORE its Stripe read; a later-started refresh
-- wins even if an older provider response arrives last. No financial decision
-- may use this cache.
create sequence if not exists public.payout_destination_cache_refresh_version_seq;
revoke all on sequence public.payout_destination_cache_refresh_version_seq from public, anon, authenticated;

create table if not exists public.payout_destination_cache_refreshes (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  applied_version bigint not null default 0
);
alter table public.payout_destination_cache_refreshes enable row level security;
revoke all on public.payout_destination_cache_refreshes from public, anon, authenticated;
grant all on public.payout_destination_cache_refreshes to service_role;

create or replace function public.begin_payout_destination_cache_refresh(p_owner_user_id uuid)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_owner_user_id is null then raise exception 'Payout cache owner is required'; end if;
  return nextval('public.payout_destination_cache_refresh_version_seq');
end;
$$;

create or replace function public.finish_payout_destination_cache_refresh(
  p_owner_user_id uuid, p_connect_account_id text, p_version bigint, p_destinations jsonb
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_applied bigint;
  v_connect_account_id text;
begin
  if p_owner_user_id is null or nullif(p_connect_account_id, '') is null or
     p_version is null or p_version <= 0 or
     jsonb_typeof(p_destinations) is distinct from 'array' then
    raise exception 'Invalid payout cache refresh';
  end if;

  -- A relinked owner must never receive a late snapshot of the old account.
  -- Lock the source profile while applying this owner's cache transaction.
  select stripe_connect_account_id into v_connect_account_id
    from public.profiles where id = p_owner_user_id for share;
  if v_connect_account_id is distinct from p_connect_account_id then return false; end if;

  insert into public.payout_destination_cache_refreshes(owner_user_id)
  values (p_owner_user_id) on conflict (owner_user_id) do nothing;
  select applied_version into v_applied
    from public.payout_destination_cache_refreshes
    where owner_user_id = p_owner_user_id for update;
  if p_version <= v_applied then return false; end if;

  insert into public.payout_destinations_cache
    (owner_user_id, stripe_external_account_id, kind, label, last4, status, is_default, updated_at)
  select p_owner_user_id, d.id, d.kind, d.label, d.last4, d.status, d.is_default, now()
    from jsonb_to_recordset(p_destinations) as d(
      id text, kind text, label text, last4 text, status text, is_default boolean
    )
  on conflict (owner_user_id, stripe_external_account_id) do update set
    kind = excluded.kind, label = excluded.label, last4 = excluded.last4,
    status = excluded.status, is_default = excluded.is_default, updated_at = excluded.updated_at;

  delete from public.payout_destinations_cache c
    where c.owner_user_id = p_owner_user_id
      and not exists (
        select 1 from jsonb_array_elements(p_destinations) d
        where d->>'id' = c.stripe_external_account_id
      );
  update public.payout_destination_cache_refreshes
    set applied_version = p_version where owner_user_id = p_owner_user_id;
  return true;
end;
$$;

revoke all on function public.begin_payout_destination_cache_refresh(uuid) from public, anon, authenticated;
revoke all on function public.finish_payout_destination_cache_refresh(uuid,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.begin_payout_destination_cache_refresh(uuid) to service_role;
grant execute on function public.finish_payout_destination_cache_refresh(uuid,text,bigint,jsonb) to service_role;
