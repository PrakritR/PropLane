-- Address prefill for the listing wizard (docs/agents/listing-prefill.md).
--
-- listing_prefill_cache: one row per normalized address with the provider's
-- facts, rent estimate and earlier-ad pointer. No account data; a repeated
-- address within 30 days costs no lookup. Retained on account purge.
--
-- listing_prefill_usage: lookups a manager spent this calendar month, read by
-- the per-plan quota. Purges with the account.
--
-- Both are service-role only: RLS on, no client grants, exactly like
-- manager_automation_settings.

create table if not exists public.listing_prefill_cache (
  address_key text primary key,
  facts jsonb,
  rent jsonb,
  prior_ad jsonb,
  source text not null default 'rentcast',
  fetched_at timestamptz not null default now()
);

create index if not exists listing_prefill_cache_fetched_idx
  on public.listing_prefill_cache (fetched_at desc);

create table if not exists public.listing_prefill_usage (
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  month text not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (manager_user_id, month)
);

alter table public.listing_prefill_cache enable row level security;
alter table public.listing_prefill_usage enable row level security;

revoke all on public.listing_prefill_cache from anon, authenticated;
revoke all on public.listing_prefill_usage from anon, authenticated;
