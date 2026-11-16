-- PropLane Jobs + landlord first-home by text (captain, Nov 15).
--
-- gig_posts          one row per priced job a manager posts ("show 4709A Room 3 Saturday 2pm, I'll pay $40"). It is a thin
--                    overlay on the ordinary service (portal_work_order_records): the service keeps its own lifecycle (Open,
--                    Assigned, Scheduled, Completed); this row anchors the OFFERED price, the short reply code vendors
--                    answer with, and the general area. The accepted bid amount lives on work_order_bids, never here.
-- gig_offers         one row per vendor the job was offered to (SMS or portal). Unique per (gig, vendor) so a retried
--                    fan-out or a retried YES is a no-op; counted per vendor per day for the rate limit.
-- sms_first_home_sessions  where a new landlord is in "add your first home" by text (one row per phone, 48h idle).
--
-- Additive and idempotent. Service role only: RLS on, every client privilege revoked.

create table if not exists public.gig_posts (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null,
  manager_user_id uuid not null,
  workspace_id uuid,
  kind text not null default 'other' check (kind in ('tour_showing', 'cleaning', 'other')),
  offered_cents integer not null check (offered_cents > 0 and offered_cents <= 100000000),
  window_text text,
  area_label text,
  zip text,
  code text not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'closed', 'cancelled')),
  source text not null default 'portal' check (source in ('sms', 'portal')),
  accepted_vendor_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gig_posts_work_order_key unique (work_order_id),
  constraint gig_posts_code_key unique (code)
);
create index if not exists gig_posts_manager_idx on public.gig_posts (manager_user_id, created_at desc);
create index if not exists gig_posts_open_idx on public.gig_posts (status, created_at desc) where status = 'open';
alter table public.gig_posts enable row level security;
revoke all on public.gig_posts from anon, authenticated;

create table if not exists public.gig_offers (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references public.gig_posts (id) on delete cascade,
  vendor_user_id uuid not null,
  channel text not null default 'sms' check (channel in ('sms', 'portal')),
  status text not null default 'sent' check (status in ('sent', 'accepted', 'declined', 'expired', 'failed')),
  sent_at timestamptz not null default now(),
  answered_at timestamptz,
  constraint gig_offers_gig_vendor_key unique (gig_id, vendor_user_id)
);
create index if not exists gig_offers_vendor_idx on public.gig_offers (vendor_user_id, sent_at desc);
alter table public.gig_offers enable row level security;
revoke all on public.gig_offers from anon, authenticated;

create table if not exists public.sms_first_home_sessions (
  phone_key text primary key,
  user_id uuid not null,
  step text not null default 'address',
  answers jsonb not null default '{}'::jsonb,
  last_sid text,
  updated_at timestamptz not null default now()
);
create index if not exists sms_first_home_sessions_user_idx on public.sms_first_home_sessions (user_id);
alter table public.sms_first_home_sessions enable row level security;
revoke all on public.sms_first_home_sessions from anon, authenticated;
