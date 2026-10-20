-- Short stays by text: the options quoted to a texter and the one they picked, held server-side so a YES
-- can only book the exact stay that was offered (never one the model re-derives). Service role only.
create table if not exists public.sms_stay_offers (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null,
  phone_key text not null check (phone_key ~ '^[0-9]{10}$'),
  options jsonb not null default '[]'::jsonb,
  selected_index integer,
  prepared_turn text,
  prepared_at timestamptz,
  status text not null default 'quoted' check (status in ('quoted', 'prepared', 'booking', 'booked', 'superseded')),
  block_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists sms_stay_offers_phone_idx
  on public.sms_stay_offers (manager_user_id, phone_key, created_at desc);

alter table public.sms_stay_offers enable row level security;
revoke all on public.sms_stay_offers from anon, authenticated;
grant all on public.sms_stay_offers to service_role;
