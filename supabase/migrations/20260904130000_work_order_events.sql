-- Durable, idempotent work-order lifecycle fanout. The event is the state-change
-- fact; delivery rows are retryable projections for each authorized audience.
create table if not exists public.work_order_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  work_order_id text not null,
  event_type text not null check (event_type in ('created', 'vendor_offered', 'accepted', 'scheduled', 'completed', 'invoiced', 'paid')),
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz
);

create index if not exists work_order_events_work_order_idx
  on public.work_order_events (manager_user_id, work_order_id, occurred_at desc);

create table if not exists public.work_order_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.work_order_events(id) on delete cascade,
  audience text not null check (audience in ('manager', 'resident', 'vendor')),
  recipient_key text not null,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  recipient_email text,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'deferred', 'digested')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  rendered jsonb not null default '{}'::jsonb,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, audience, recipient_key)
);

create index if not exists work_order_event_deliveries_retry_idx
  on public.work_order_event_deliveries (status, next_attempt_at)
  where status in ('pending', 'failed', 'deferred');
create index if not exists work_order_event_deliveries_rate_idx
  on public.work_order_event_deliveries (recipient_key, created_at desc);

alter table public.work_order_events enable row level security;
alter table public.work_order_event_deliveries enable row level security;
revoke all on public.work_order_events from anon, authenticated;
revoke all on public.work_order_event_deliveries from anon, authenticated;

comment on table public.work_order_events is
  'Canonical idempotent work-order state changes. Service-role writers only.';
comment on table public.work_order_event_deliveries is
  'Retryable, audience-scoped notification projections for work-order events.';
