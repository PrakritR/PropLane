-- One-number fixes: (1) a Twilio retry of an unknown sender's text gets the SAME reply back (the whole
-- onboarding turn is idempotent per MessageSid); (2) the once-per-30-days "We've moved" marker for
-- texts that still arrive on an OLD per-workspace work number after the switch, and the queue behind
-- the one-time cutover notices. Additive and idempotent. Service role only (RLS on, no anon/authenticated grant).

-- The reply an unknown sender's turn produced, keyed on the provider MessageSid. Short-lived: pruned after an hour.
create table if not exists public.sms_onboarding_replies (
  message_sid text primary key,
  phone_key text not null,
  turn jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists sms_onboarding_replies_created_idx on public.sms_onboarding_replies (created_at);

-- One row per phone told "We've moved to <shared number>". `queued` = a cutover notice waiting for the
-- platform dispatcher (available_at, daytime Pacific); `sent` = told at notified_at, and not told again
-- by an auto-reply for 30 days.
create table if not exists public.sms_moved_notices (
  phone_key text primary key,
  workspace_id uuid references public.portal_workspaces (id) on delete cascade,
  source text not null check (source in ('cutover', 'auto_reply')),
  status text not null default 'queued' check (status in ('queued', 'sent')),
  available_at timestamptz not null default now(),
  notified_at timestamptz,
  message_sid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sms_moved_notices_due_idx on public.sms_moved_notices (available_at) where status = 'queued';

do $$
declare t text;
begin
  foreach t in array array['sms_onboarding_replies', 'sms_moved_notices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
