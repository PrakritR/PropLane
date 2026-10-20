-- "Skip for now" on the verify-phone screen is capped per account (security review, Oct 20).
--
-- The skip exists for a PROVIDER OUTAGE, but for `verify_phone` the person chooses the number: typing an
-- undeliverable one makes the send fail, which is the very proof the skip asks for. Uncapped, that let any
-- account opt out of `phone_required` on demand, 30 days at a time.
--
-- 1. phone_required_skips: one append-only row per granted skip. The cap is read from it - at most one skip per
--    account per 7 days, and 3 in the account's lifetime. Service role only.
-- 2. sms_runtime_config.phone_send_outage: the platform-wide escape. While it is on, the cap is not applied, so a
--    real provider outage can never lock everyone out. Off by default.
--
-- Idempotent; additive.

create table if not exists public.phone_required_skips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists phone_required_skips_user_idx
  on public.phone_required_skips (user_id, created_at desc);

alter table public.phone_required_skips enable row level security;
revoke all on public.phone_required_skips from anon, authenticated;
grant all on public.phone_required_skips to service_role;

alter table public.sms_runtime_config
  add column if not exists phone_send_outage boolean not null default false;
