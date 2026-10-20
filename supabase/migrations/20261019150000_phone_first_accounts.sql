-- Phone-first accounts: a phone_required switch, and sign-up by text (state + proof).
-- Implementation map: docs/agents/one-number.md § W26. Every statement is idempotent.
--
-- 1. sms_runtime_config.phone_required: the verify-phone gate for EVERY signed-in account (email, Google,
--    Apple), whatever the line mode. It defaults to FALSE and an existing row keeps FALSE: production turns it on
--    deliberately (`update sms_runtime_config set phone_required = true`) after verifying that codes reach a phone
--    there. The shared-mode gate (line_mode = 'shared') is a separate, older switch and is untouched.
-- 2. phone_otp_challenges.purpose gains 'sms_signup': the code texted in OUR message during sign-up by text, which the
--    person must text back (caller ID can be spoofed; echoing a code sent to the number proves they receive it).
-- 3. sms_signup_sessions: one row per phone that is signing up by text (role, step, answers). Service role only.

alter table public.sms_runtime_config
  add column if not exists phone_required boolean not null default false;

alter table public.phone_otp_challenges drop constraint if exists phone_otp_challenges_purpose_check;
alter table public.phone_otp_challenges
  add constraint phone_otp_challenges_purpose_check
  check (purpose in ('link_unlock', 'public_bind', 'sign_in', 'change_number_old', 'change_number_new', 'sms_signup'));

create table if not exists public.sms_signup_sessions (
  phone_key text primary key check (phone_key ~ '^[0-9]{10}$'),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  role text check (role is null or role in ('manager', 'vendor', 'resident')),
  step text not null default 'role'
    check (step in ('role', 'name', 'business', 'homes', 'trade', 'area', 'home', 'email', 'code', 'done')),
  answers jsonb not null default '{}'::jsonb,
  -- Webhook replay: the MessageSid last handled and what it did, so a retried webhook changes nothing.
  last_sid text,
  last_kind text,
  user_id uuid references auth.users (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sms_signup_sessions_user_idx on public.sms_signup_sessions (user_id) where user_id is not null;

alter table public.sms_signup_sessions enable row level security;
revoke all on public.sms_signup_sessions from anon, authenticated;
grant all on public.sms_signup_sessions to service_role;
