-- Two additions to the SMS confirmation-code store (security review, Oct 20).
--
-- 1. sms_confirmation_failures: one append-only row per WRONG code, keyed by a keyed hash of the texting phone (never the
--    number). The three-guess cap belongs to one proposal; this is the budget across proposals: ten wrong codes from one
--    phone in 24 hours lock the coded path for that phone (the code reads the last 24 hours; old rows are inert).
-- 2. subject_kind gains 'stay_request': the 4-digit code a short-stay texter must repeat ("Reply YES 4821") before a stay
--    is requested for the number that texted.
--
-- Idempotent; additive. Service role only.

create table if not exists public.sms_confirmation_failures (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null,
  failed_at timestamptz not null default now()
);

create index if not exists sms_confirmation_failures_phone_idx
  on public.sms_confirmation_failures (phone_hash, failed_at desc);

alter table public.sms_confirmation_failures enable row level security;
revoke all on public.sms_confirmation_failures from anon, authenticated;
grant all on public.sms_confirmation_failures to service_role;

alter table public.sms_confirmation_codes drop constraint if exists sms_confirmation_codes_subject_kind_check;
alter table public.sms_confirmation_codes
  add constraint sms_confirmation_codes_subject_kind_check
  check (subject_kind in ('pending_action', 'dispatch_approval', 'dispatch_quote', 'dispatch_invoice', 'dispatch_retry', 'stay_request'));
