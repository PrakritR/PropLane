-- Booking-channel finances (Airbnb, Booking.com): one row per (platform, confirmation code, kind), read from the host's
-- forwarded notification mail or an uploaded CSV export. REPORTING rows only: income a channel pays the host. They are never a
-- resident charge and never move the party ledger. No client grant, no client policy: service-role routes only.
-- Additive and idempotent; safe to re-run.
create table if not exists public.channel_payout_records (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid,
  platform text not null,
  kind text not null,
  confirmation_code text not null,
  property_id text,
  property_label text,
  room_id text,
  room_label text,
  connection_id uuid,
  source_uid text,
  guest_label text,
  check_in date,
  check_out date,
  gross_cents integer,
  host_fee_cents integer,
  tax_cents integer,
  payout_cents integer,
  currency text not null default 'USD',
  paid_at timestamptz,
  source text not null default 'email',
  review_status text not null default 'ok',
  email_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_payout_records_key unique (manager_user_id, platform, confirmation_code, kind),
  constraint channel_payout_records_platform_check check (platform in ('airbnb', 'booking_com')),
  constraint channel_payout_records_kind_check check (kind in ('reservation', 'payout')),
  constraint channel_payout_records_source_check check (source in ('email', 'csv')),
  constraint channel_payout_records_review_check check (review_status in ('ok', 'needs_room', 'needs_review')),
  constraint channel_payout_records_cents_check check (
    (gross_cents is null or gross_cents between 0 and 100000000)
    and (host_fee_cents is null or host_fee_cents between 0 and 100000000)
    and (tax_cents is null or tax_cents between 0 and 100000000)
    and (payout_cents is null or payout_cents between 0 and 100000000)
  ),
  constraint channel_payout_records_code_check check (char_length(confirmation_code) between 3 and 64)
);
create index if not exists channel_payout_records_owner_idx on public.channel_payout_records (manager_user_id, platform, check_out);
create index if not exists channel_payout_records_review_idx on public.channel_payout_records (manager_user_id, review_status) where review_status <> 'ok';
alter table public.channel_payout_records enable row level security;
revoke all on table public.channel_payout_records from anon, authenticated;
grant all on table public.channel_payout_records to service_role;

-- Every finance mail that arrived, parsed or not: the "last mail received" per channel and the review queue for a mail whose
-- amounts the parser would not vouch for. Bounded excerpt only; one row per inbound email id.
create table if not exists public.channel_finance_mail (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid,
  platform text not null,
  email_id text not null,
  subject text not null default '',
  excerpt text not null default '',
  received_at timestamptz not null default now(),
  status text not null default 'flagged',
  record_id uuid references public.channel_payout_records (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint channel_finance_mail_key unique (manager_user_id, email_id),
  constraint channel_finance_mail_platform_check check (platform in ('airbnb', 'booking_com')),
  constraint channel_finance_mail_status_check check (status in ('recorded', 'flagged', 'dismissed')),
  constraint channel_finance_mail_excerpt_check check (char_length(excerpt) <= 4000)
);
create index if not exists channel_finance_mail_owner_idx on public.channel_finance_mail (manager_user_id, platform, received_at desc);
alter table public.channel_finance_mail enable row level security;
revoke all on table public.channel_finance_mail from anon, authenticated;
grant all on table public.channel_finance_mail to service_role;
