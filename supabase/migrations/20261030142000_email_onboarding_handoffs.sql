create table if not exists public.email_onboarding_handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_digest text not null unique,
  application_id text references public.manager_application_records(id) on delete cascade,
  tour_inquiry_id text,
  manager_purchase_id uuid references public.manager_purchases(id) on delete cascade,
  property_id text references public.manager_property_records(id) on delete cascade,
  listing_room_id text,
  bundle_id text,
  application_form_id text,
  rental_type text check (rental_type is null or rental_type in ('standard','short_term')),
  tier text check (tier is null or tier in ('free','pro','business')),
  billing text check (billing is null or billing in ('monthly','annual')),
  intent text not null default 'generic' check (intent in ('generic','resident','manager','vendor','tour','manager_paid','application')),
  status text not null default 'pending' check (status in ('pending','processing','completed','consumed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.email_onboarding_handoffs enable row level security;
revoke all on public.email_onboarding_handoffs from public, anon, authenticated;
grant all on public.email_onboarding_handoffs to service_role;
create index if not exists email_onboarding_handoffs_expiry_idx on public.email_onboarding_handoffs (expires_at);
create or replace function public.purge_expired_email_onboarding_handoffs()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.email_onboarding_handoffs where id in (
    select id from public.email_onboarding_handoffs where expires_at < now() order by expires_at limit 100
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.purge_expired_email_onboarding_handoffs() from public, anon, authenticated;
grant execute on function public.purge_expired_email_onboarding_handoffs() to service_role;
