-- design-1112 §2.6 (Package D): the automated check-in / check-out ledger.
-- One row per (stay, kind): the idempotency anchor and the log shown on the booking.
-- Additive and idempotent. Service-role only: RLS on, no client grant.
create table if not exists public.stay_message_sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  stay_key text not null,                 -- 'block:<room_date_block id>' or 'lease:<application id>'
  kind text not null check (kind in ('check_in','check_out','check_in_correction')),
  status text not null check (status in ('scheduled','sent','partial','failed','held','cancelled')),
  hold_reason text,                       -- 'room_code_missing' | 'foreign_code' | 'no_contact' | 'source_off' | 'cancelled'
  due_at timestamptz not null,
  sent_at timestamptz,
  room_id text,
  facts_hash text,                        -- sha256 of room + room code + dates used in the body (never the code itself)
  channels jsonb not null default '{}'::jsonb,   -- { sms: {status,reason}, email: …, inbox: …, attempts: n }
  thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists stay_message_sends_once on public.stay_message_sends (stay_key, kind)
  where kind in ('check_in','check_out');
create index if not exists stay_message_sends_stay_idx on public.stay_message_sends (stay_key, kind, created_at desc);
create index if not exists stay_message_sends_due_idx on public.stay_message_sends (status, due_at);
alter table public.stay_message_sends enable row level security;
revoke all on public.stay_message_sends from anon, authenticated;
-- A correction repeats only for a DIFFERENT set of facts: one per (stay, facts hash).
create unique index if not exists stay_message_sends_correction_once on public.stay_message_sends (stay_key, facts_hash)
  where kind = 'check_in_correction';
-- Claim-before-send: a row is 'sending' under a claim token while a sweep delivers it; a crashed sweep's stale claim
-- (> 10 minutes) can be re-claimed, and each channel's result is checkpointed so a re-claim never repeats a delivered channel.
alter table public.stay_message_sends add column if not exists claim_token text;
alter table public.stay_message_sends add column if not exists claimed_at timestamptz;
alter table public.stay_message_sends drop constraint if exists stay_message_sends_status_check;
alter table public.stay_message_sends add constraint stay_message_sends_status_check
  check (status in ('scheduled','sending','sent','partial','failed','held','cancelled'));
