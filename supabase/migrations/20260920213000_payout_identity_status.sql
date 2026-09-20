-- PLAN-0920-1500 Part C: display-only cache of Stripe Connect identity
-- verification status per payout owner. Stripe's Accounts API stays the
-- source of truth (the identity route always reads it fresh); this table
-- only lets a settings page show a status without an extra round trip, and
-- is refreshed by the `account.updated` webhook (`handleStripeAccountUpdated`).

create table if not exists public.payout_identity_status (
  owner_user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null check (status in ('verified', 'pending', 'needs_info', 'restricted')),
  currently_due jsonb not null default '[]'::jsonb,
  pending_verification jsonb not null default '[]'::jsonb,
  disabled_reason text,
  updated_at timestamptz not null default now()
);

alter table public.payout_identity_status enable row level security;

drop policy if exists payout_identity_status_owner_read on public.payout_identity_status;

-- SELECT-only for the owner — every write goes through the service-role
-- client (the webhook handler / identity route), never `authenticated`. See
-- AGENTS.md "The PostgREST surface is public — RLS row predicates are not a
-- column gate".
create policy payout_identity_status_owner_read on public.payout_identity_status
  for select using (owner_user_id = auth.uid());
