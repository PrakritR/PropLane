-- Payouts, fully in-house (PLAN-0920-1500 part B): display cache of the bank
-- accounts / debit cards attached to a manager's or vendor's Stripe Connect
-- account. Stripe stays the source of truth for every read the payouts page
-- and its sheets do (`listPayoutDestinations`); this table exists only so a
-- future surface (e.g. the withdraw sheet's "To" picker) can show a fast,
-- non-authoritative last4/brand list without an extra Stripe round trip.
--
-- Never stores anything beyond what `listPayoutDestinations` already returns
-- to the client — last4 and brand/bank name, never a full account or card
-- number (see `src/lib/stripe-external-accounts.server.ts`).

create table if not exists public.payout_destinations_cache (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  stripe_external_account_id text not null,
  kind text not null check (kind in ('bank', 'card')),
  label text not null,
  last4 text not null,
  status text not null check (status in ('verified', 'verifying', 'errored')),
  is_default boolean not null default false,
  updated_at timestamptz not null default now()
);

create unique index if not exists payout_destinations_cache_owner_ea_unique
  on public.payout_destinations_cache (owner_user_id, stripe_external_account_id);
create index if not exists payout_destinations_cache_owner_idx
  on public.payout_destinations_cache (owner_user_id);

alter table public.payout_destinations_cache enable row level security;

-- SELECT-only for the owner — every write is server-side via the service-role
-- client after a live Stripe read (`refreshPayoutDestinationsCacheFromStripe`),
-- matching `stripe_payouts_manager_read` above. `owner_user_id` holds the
-- vendor's own id for a vendor's cache row (same generic pattern
-- `profiles.stripe_connect_account_id` already uses).
drop policy if exists payout_destinations_cache_owner_read on public.payout_destinations_cache;
create policy payout_destinations_cache_owner_read on public.payout_destinations_cache
  for select using (owner_user_id = auth.uid());

-- Purge manifest: classified in `src/lib/auth/account-purge-manifest.ts`.
