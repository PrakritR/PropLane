-- W12: role-detecting first conversation, the sandbox DEMO, landlord and vendor setup by text.
-- Additive and idempotent. Every table is service-role only (RLS on, no anon/authenticated grant).

-- A demo conversation (SMS keyed on the phone, web keyed on a browser session id). Sandbox state only:
-- the demo never writes a real row (docs/agents/demo-sandbox.md).
create table if not exists public.sms_demo_sessions (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('sms', 'web')),
  session_key text not null,
  phone_key text,
  step text not null default 'applicant',
  context jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sms_demo_sessions_live_idx
  on public.sms_demo_sessions (channel, session_key) where finished_at is null;
create index if not exists sms_demo_sessions_phone_idx
  on public.sms_demo_sessions (phone_key) where phone_key is not null;

-- What an unknown number told us about itself: its role (asked at most once) and house hints.
create table if not exists public.sms_onboarding_state (
  phone_key text primary key,
  role text check (role in ('searcher', 'landlord', 'vendor')),
  asked_at timestamptz,
  stage text,
  hints jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A new vendor's intake (trade, area, rates, insurance), waiting for PropLane admin.
create table if not exists public.sms_vendor_leads (
  id uuid primary key default gen_random_uuid(),
  phone_key text not null,
  status text not null default 'collecting' check (status in ('collecting', 'pending', 'approved', 'declined')),
  profile jsonb not null default '{}'::jsonb,
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sms_vendor_leads_live_phone_idx
  on public.sms_vendor_leads (phone_key) where status in ('collecting', 'pending');

-- "Finish setup" links texted after the demo or the vendor intake. Only the SHA-256 of the token is stored.
-- phone_key null = an open link from the web demo (the page asks for the phone and texts it a code).
create table if not exists public.sms_setup_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('landlord', 'vendor')),
  phone_key text,
  context jsonb not null default '{}'::jsonb,
  invited_by_workspace_id uuid references public.portal_workspaces (id) on delete set null,
  expires_at timestamptz not null,
  waitlisted_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sms_setup_links_phone_idx on public.sms_setup_links (phone_key, kind);

do $$
declare t text;
begin
  foreach t in array array['sms_demo_sessions', 'sms_onboarding_state', 'sms_vendor_leads', 'sms_setup_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
