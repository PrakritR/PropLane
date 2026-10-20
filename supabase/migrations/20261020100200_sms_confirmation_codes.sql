-- The 4-digit code a manager phone must repeat to confirm a write on the PropLane line.
--
-- Identity on that line is a spoofable caller ID, so a write is confirmed only by the code shown in its own ask.
-- The code is RANDOM per proposal and stored HASHED (keyed HMAC bound to the subject), and the row carries the
-- attempt count: three wrong codes cancel the proposal, so a 4-digit secret cannot be walked through blind.
--
-- One row per subject (the pending action, the dispatch run's approval / quote / invoice). No account column: the
-- subject's own table owns the money and the identity, and a stale hash is worthless after its proposal is gone.
--
-- Idempotent; additive. Service role only.

create table if not exists public.sms_confirmation_codes (
  subject_kind text not null check (subject_kind in ('pending_action', 'dispatch_approval', 'dispatch_quote', 'dispatch_invoice')),
  subject_id text not null,
  code_hash text not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (subject_kind, subject_id)
);

create index if not exists sms_confirmation_codes_expiry_idx
  on public.sms_confirmation_codes (expires_at);

alter table public.sms_confirmation_codes enable row level security;
revoke all on public.sms_confirmation_codes from anon, authenticated;
grant all on public.sms_confirmation_codes to service_role;
