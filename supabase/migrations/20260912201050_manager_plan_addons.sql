-- Plan add-ons: how many extra listings, work numbers, workspaces and seats a
-- paying manager holds beyond the plan bundle (round 3 plan model). Service
-- role only — quantities change through /api/manager/plan-addons, which
-- validates the plan, the cap and the Stripe subscription item before writing.
create table if not exists public.manager_plan_addons (
  manager_user_id uuid not null references public.profiles(id) on delete cascade,
  addon_id text not null check (addon_id in ('extra_listing', 'extra_work_number', 'extra_workspace', 'extra_seat')),
  quantity integer not null default 0 check (quantity >= 0 and quantity <= 100),
  stripe_subscription_item_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (manager_user_id, addon_id)
);
alter table public.manager_plan_addons enable row level security;
revoke all on public.manager_plan_addons from public, anon, authenticated;
grant all on public.manager_plan_addons to service_role;

-- The workspace ceiling was the Business bundle (3). Business can now add
-- workspaces beyond its three; the plan cap (`/api/workspaces`) still narrows
-- this per tier, and Free and Pro never reach it.
create or replace function public.enforce_portal_workspace_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and new.owner_user_id = old.owner_user_id then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-owner:' || new.owner_user_id::text, 0));
  if TG_OP = 'INSERT' and new.is_default and exists (
    select 1 from public.portal_workspaces where owner_user_id = new.owner_user_id and is_default
  ) then return new; end if;
  if (select count(*) from public.portal_workspaces where owner_user_id = new.owner_user_id) >= 10 then
    raise exception 'You can own up to 10 workspaces.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_portal_workspace_limit() from public, anon, authenticated;
