-- Manager communication usage billing (pay-as-you-go meters).
-- Service-role only; clients read through API routes.

create table if not exists public.manager_comms_billing_accounts (
  manager_user_id uuid primary key references public.profiles (id) on delete cascade,
  billing_paused_at timestamptz,
  billing_pause_reason text,
  monthly_budget_cents integer,
  has_default_payment_method boolean not null default false,
  payment_method_checked_at timestamptz,
  notified_budget_80_at timestamptz,
  notified_budget_100_at timestamptz,
  last_payment_failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.manager_comms_usage_events (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references public.profiles (id) on delete cascade,
  meter text not null,
  quantity numeric not null default 1 check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint manager_comms_usage_events_meter_check check (
    meter in (
      'sms_outbound_segment',
      'sms_inbound_segment',
      'voice_minute',
      'voice_speech_gather',
      'voice_recording_minute',
      'ai_agent_turn',
      'work_number_monthly'
    )
  )
);

create unique index if not exists manager_comms_usage_events_idempotency_uniq
  on public.manager_comms_usage_events (idempotency_key);

create index if not exists manager_comms_usage_events_manager_created_idx
  on public.manager_comms_usage_events (manager_user_id, created_at desc);

alter table public.manager_comms_billing_accounts enable row level security;
alter table public.manager_comms_usage_events enable row level security;

revoke all on table public.manager_comms_billing_accounts from anon, authenticated;
revoke all on table public.manager_comms_usage_events from anon, authenticated;
