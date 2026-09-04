-- Per-manager PropLane Assistant email (mirrors manager_sms_numbers lifecycle shape).
-- Service-role only: RLS enabled, no client policies.

create table if not exists public.manager_assistant_emails (
  manager_user_id uuid primary key references auth.users (id) on delete cascade,
  inbox_token     text not null,
  provision_state text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint manager_assistant_emails_provision_state_check
    check (provision_state in ('active', 'released'))
);

create unique index if not exists manager_assistant_emails_token_uniq
  on public.manager_assistant_emails (inbox_token)
  where provision_state = 'active';

alter table public.manager_assistant_emails enable row level security;
revoke all on table public.manager_assistant_emails from anon, authenticated;

-- Idempotent inbound processing keyed on Resend email id.
create table if not exists public.manager_assistant_email_inbound (
  resend_email_id text primary key,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now()
);

alter table public.manager_assistant_email_inbound enable row level security;
revoke all on table public.manager_assistant_email_inbound from anon, authenticated;

-- Manager email agent sessions (vendor_phone_e164 stores the actor email).
create unique index if not exists agent_sessions_manager_email_identity_uidx
  on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)
  where kind = 'manager_email'
    and user_id is not null
    and vendor_phone_e164 is not null;
