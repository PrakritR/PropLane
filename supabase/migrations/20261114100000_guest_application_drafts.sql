-- A renter from Facebook, Zillow or Roomies applies WITHOUT an account (captain, Nov 14). The finished application is
-- held here until the renter proves a phone or mailbox, then claimed by the resident account that proof creates.
-- Only the SHA-256 of the unguessable draft token is stored. The draft expires in 24 hours and its body is wiped the
-- moment it is claimed. Additive and idempotent. Service role only: RLS on, no client grants.
create table if not exists public.guest_application_drafts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  property_id text not null,
  email text,
  phone_e164 text,
  draft jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'claimed')),
  claimed_by_user_id uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists guest_application_drafts_phone_idx on public.guest_application_drafts (phone_e164) where status = 'pending';
create index if not exists guest_application_drafts_email_idx on public.guest_application_drafts (email) where status = 'pending';
create index if not exists guest_application_drafts_expiry_idx on public.guest_application_drafts (expires_at);
alter table public.guest_application_drafts enable row level security;
revoke all on public.guest_application_drafts from anon, authenticated;

create or replace function public.purge_expired_guest_application_drafts()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.guest_application_drafts
    where expires_at < now() or (status = 'claimed' and claimed_at < now() - interval '7 days')
    returning 1
  )
  select count(*)::integer from gone;
$$;
revoke all on function public.purge_expired_guest_application_drafts() from public, anon, authenticated;
grant execute on function public.purge_expired_guest_application_drafts() to service_role;
