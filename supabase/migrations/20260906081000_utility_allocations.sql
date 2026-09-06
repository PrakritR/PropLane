create table public.property_utility_allocations (
  id uuid primary key,
  manager_user_id uuid not null references auth.users(id),
  bill_id uuid not null references public.manager_bills(id),
  property_id text not null,
  service_start date not null,
  service_end date not null check (service_end >= service_start),
  request_hash text not null,
  snapshot jsonb not null,
  status text not null default 'prepared' check(status in ('prepared','completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(manager_user_id, bill_id)
);
alter table public.property_utility_allocations enable row level security;
create policy utility_allocations_owner_read on public.property_utility_allocations
  for select to authenticated using (manager_user_id = auth.uid());
revoke all on public.property_utility_allocations from anon, authenticated;
grant select on public.property_utility_allocations to authenticated;
grant all on public.property_utility_allocations to service_role;
