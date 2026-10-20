-- One-number W11: preset auto-sends (automations) + escalations inbox.
-- Additive and idempotent. Service-role only (RLS on, no anon/authenticated grants).

-- 1. Per-workspace mode for each preset. A workspace with no row keeps the preset's default
--    (src/lib/automations/presets.ts). `template` is the manager's own wording, null = the default.
create table if not exists public.workspace_automation_presets (
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  preset text not null check (length(preset) between 1 and 40),
  mode text not null check (mode in ('auto', 'draft', 'off')),
  template text check (template is null or length(template) <= 600),
  channel text not null default 'sms' check (channel in ('sms')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, preset)
);

-- 2. One row per fired (or held) preset text. The unique key is the idempotency: a preset fires once
--    per moment however many times the sweep runs. `held` = a draft waiting for the manager.
create table if not exists public.workspace_automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null,
  preset text not null check (length(preset) between 1 and 40),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  audience text not null check (audience in ('resident', 'group')),
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'held', 'dismissed', 'skipped', 'failed')),
  mode text not null check (mode in ('auto', 'draft')),
  property_id text,
  phone_key text,
  body text check (body is null or length(body) <= 1600),
  reason text,
  draft_id uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (workspace_id, idempotency_key)
);
create index if not exists workspace_automation_runs_held_idx
  on public.workspace_automation_runs (workspace_id, created_at desc)
  where status = 'held';

-- 3. Escalations inbox: the existing escalation rows (W6) gain where they came from, the thread
--    excerpt the manager reads, and who resolved them.
alter table public.sms_escalated_questions
  add column if not exists source text not null default 'agent';
alter table public.sms_escalated_questions
  drop constraint if exists sms_escalated_questions_source_check;
alter table public.sms_escalated_questions
  add constraint sms_escalated_questions_source_check check (source in ('agent', 'ra', 'unanswered'));
alter table public.sms_escalated_questions
  add column if not exists excerpt text;
alter table public.sms_escalated_questions
  add column if not exists resolved_by uuid;
create index if not exists sms_escalated_questions_workspace_idx
  on public.sms_escalated_questions (workspace_id, escalated_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['workspace_automation_presets', 'workspace_automation_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
