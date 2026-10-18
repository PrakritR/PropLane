-- One-number W6: knowledge base audience, escalated-question capture, AI drafts.
-- Additive and idempotent. Service-role only (RLS on, no anon/authenticated grants).

-- 1. Who may be told an approved answer. 'all' = anyone texting (prospects, vendors),
--    'residents' = signed residents and the team, 'team' = managers only.
alter table public.property_knowledge_entries
  add column if not exists audience text not null default 'residents';
alter table public.property_knowledge_entries
  drop constraint if exists property_knowledge_entries_audience_check;
alter table public.property_knowledge_entries
  add constraint property_knowledge_entries_audience_check
  check (audience in ('all', 'residents', 'team'));

-- 2. Escalated questions: written when an agent hands a texter's question to the team.
--    A manager's later answer to that texter becomes a suggested knowledge entry; open
--    rows with no approved entry feed the weekly digest.
create table if not exists public.sms_escalated_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null,
  phone_key text not null,
  role text not null check (role in ('manager', 'resident', 'vendor', 'applicant', 'prospect')),
  property_id text,
  topic text not null default 'other',
  question text not null check (length(question) between 1 and 500),
  escalated_at timestamptz not null default now(),
  resolved_at timestamptz,
  entry_id uuid references public.property_knowledge_entries (id) on delete set null
);
create index if not exists sms_escalated_questions_open_idx
  on public.sms_escalated_questions (workspace_id, phone_key, escalated_at desc)
  where resolved_at is null;

-- 3. AI drafts held for a manager (reply mode 'draft') or flagged for review ('auto_review').
create table if not exists public.sms_ai_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null,
  phone_key text not null,
  role text not null check (role in ('manager', 'resident', 'vendor', 'applicant', 'prospect')),
  topic text not null,
  mode text not null check (mode in ('draft', 'auto_review')),
  inbound_text text not null,
  body text not null check (length(body) between 1 and 1600),
  property_id text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'edited_sent', 'rejected', 'reviewed')),
  sent_text text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists sms_ai_reply_drafts_pending_idx
  on public.sms_ai_reply_drafts (workspace_id, phone_key, created_at desc)
  where status = 'pending';

-- 4. Weekly digest bookkeeping (one send per workspace per week).
create table if not exists public.sms_knowledge_digests (
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  week_key text not null,
  sent_at timestamptz not null default now(),
  primary key (workspace_id, week_key)
);

do $$
declare
  t text;
begin
  foreach t in array array['sms_escalated_questions', 'sms_ai_reply_drafts', 'sms_knowledge_digests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
