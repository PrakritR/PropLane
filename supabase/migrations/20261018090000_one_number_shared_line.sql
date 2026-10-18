-- One-number SMS: additive schema for the shared PropLane line.
-- Spec: docs/agents/one-number-spec.md · implementation map: docs/agents/one-number.md.
--
-- Everything here is ADDITIVE (new tables, nullable columns). Nothing is dropped.
-- Every new table is service-role only, like every other SMS table: RLS on, no
-- anon/authenticated grants, so the public PostgREST surface can never read a
-- thread, lead, code or link — workspace scoping happens in server loaders that
-- re-derive the workspace from the authenticated session.

-- 1. Line mode on the existing rollout switch -------------------------------
alter table public.sms_runtime_config
  add column if not exists line_mode text not null default 'per_workspace',
  add column if not exists shared_number_e164 text,
  add column if not exists shared_messaging_service_sid text,
  add column if not exists shared_pilot_workspace_ids uuid[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_runtime_config_line_mode_check') then
    alter table public.sms_runtime_config
      add constraint sms_runtime_config_line_mode_check
      check (line_mode in ('per_workspace', 'shadow', 'shared'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_runtime_config_shared_number_e164_check') then
    alter table public.sms_runtime_config
      add constraint sms_runtime_config_shared_number_e164_check
      check (shared_number_e164 is null or shared_number_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

-- 2. Router state ------------------------------------------------------------
-- One row per phone on the shared line: which workspace the person is talking
-- to right now, and a pending "Is this about A or B?" question.
create table if not exists public.sms_line_sessions (
  phone_key text primary key,
  current_workspace_id uuid references public.portal_workspaces (id) on delete set null,
  active_role text check (active_role in ('manager', 'resident', 'vendor', 'applicant', 'prospect')),
  pending_candidates jsonb,
  pending_asked_at timestamptz,
  last_inbound_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Per (phone, workspace) thread state: HUMAN pauses the AI for that team only.
create table if not exists public.sms_line_thread_state (
  phone_key text not null,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  role text not null check (role in ('manager', 'resident', 'vendor', 'applicant', 'prospect')),
  ai_paused boolean not null default false,
  paused_at timestamptz,
  paused_reason text check (paused_reason is null or paused_reason in ('human_keyword', 'manager_takeover', 'emergency')),
  resumed_at timestamptz,
  resumed_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (phone_key, workspace_id)
);

-- Shadow mode: what the router WOULD have decided, next to who really owned it.
create table if not exists public.sms_line_shadow_decisions (
  id uuid primary key default gen_random_uuid(),
  message_sid text not null unique,
  phone_key text not null,
  decision jsonb not null,
  actual_owner_user_id uuid,
  actual_workspace_id uuid,
  agrees boolean,
  created_at timestamptz not null default now()
);
create index if not exists sms_line_shadow_decisions_created_idx
  on public.sms_line_shadow_decisions (created_at desc);

-- 3. Entry codes ("Text BROOKLYN5 to …") ---------------------------------------
create table if not exists public.sms_entry_codes (
  code text primary key check (code ~ '^[A-Z0-9]{3,16}$'),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  property_id text not null references public.manager_property_records (id) on delete cascade,
  label text,
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sms_entry_codes_workspace_idx on public.sms_entry_codes (workspace_id);
create index if not exists sms_entry_codes_property_idx on public.sms_entry_codes (property_id);

-- 4. Unassigned leads (step 7: new prospect, no code) -------------------------
create table if not exists public.sms_unassigned_leads (
  id uuid primary key default gen_random_uuid(),
  phone_key text not null,
  status text not null default 'open' check (status in ('open', 'assigned', 'closed')),
  -- Qualifying answers: budget, move-in, lease length, area, room type, household size.
  profile jsonb not null default '{}'::jsonb,
  assigned_workspace_id uuid references public.portal_workspaces (id) on delete set null,
  assigned_property_id text references public.manager_property_records (id) on delete set null,
  assigned_at timestamptz,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sms_unassigned_leads_open_phone
  on public.sms_unassigned_leads (phone_key) where status = 'open';

create table if not exists public.sms_unassigned_lead_turns (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sms_unassigned_leads (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  message_sid text unique,
  media jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sms_unassigned_lead_turns_lead_idx
  on public.sms_unassigned_lead_turns (lead_id, created_at);

-- 5. Global contact keyed on the phone ----------------------------------------
create table if not exists public.sms_phone_contacts (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_key text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  display_name text check (display_name is null or length(display_name) between 1 and 80),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists sms_phone_contacts_user_idx on public.sms_phone_contacts (user_id);

-- 6. Workspace stamps on the message tables (nullable; backfilled by script) --
alter table public.sms_projection_turns add column if not exists workspace_id uuid;
alter table public.sms_outbox add column if not exists workspace_id uuid;
alter table public.sms_inbound_receipts add column if not exists workspace_id uuid;
alter table public.manager_sms_messages add column if not exists workspace_id uuid;
alter table public.inbound_sms_log add column if not exists workspace_id uuid;
alter table public.manager_sms_contacts add column if not exists workspace_id uuid;
create index if not exists sms_projection_turns_workspace_idx on public.sms_projection_turns (workspace_id);
create index if not exists sms_outbox_workspace_idx on public.sms_outbox (workspace_id);
create index if not exists manager_sms_messages_workspace_idx on public.manager_sms_messages (workspace_id);
create index if not exists inbound_sms_log_workspace_idx on public.inbound_sms_log (workspace_id);

-- 7. MMS files (private `sms-media` bucket) ------------------------------------
create table if not exists public.sms_media_files (
  id uuid primary key default gen_random_uuid(),
  message_sid text not null,
  media_index integer not null check (media_index between 0 and 9),
  workspace_id uuid references public.portal_workspaces (id) on delete set null,
  sender_phone_key text not null,
  storage_path text not null,
  content_type text not null,
  byte_size integer,
  linked_type text check (linked_type is null or linked_type in (
    'work_order', 'service_request', 'inspection', 'move_in', 'move_out', 'listing', 'vendor_job', 'lead'
  )),
  linked_id text,
  created_at timestamptz not null default now(),
  unique (message_sid, media_index)
);
create index if not exists sms_media_files_workspace_idx on public.sms_media_files (workspace_id, created_at desc);
create index if not exists sms_media_files_link_idx on public.sms_media_files (linked_type, linked_id);

-- 8. Phone-bound signed links (one link service) -------------------------------
create table if not exists public.phone_bound_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  phone_key text not null,
  workspace_id uuid references public.portal_workspaces (id) on delete cascade,
  purpose text not null check (purpose in (
    'gallery', 'tour', 'application', 'lease', 'rent', 'move_in', 'job', 'payouts'
  )),
  target_type text not null,
  target_id text not null,
  requires_otp boolean not null,
  expires_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  open_count integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists phone_bound_links_phone_idx on public.phone_bound_links (phone_key, purpose);

-- Verified page sessions after a code unlock (30 min money / 7 days otherwise).
create table if not exists public.phone_bound_link_sessions (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null unique,
  link_id uuid not null references public.phone_bound_links (id) on delete cascade,
  phone_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Link-unlock / public-bind codes keyed on the phone (phone_verifications is
-- keyed on user_id, and a texter may have no account yet).
create table if not exists public.phone_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  phone_key text not null,
  purpose text not null check (purpose in ('link_unlock', 'public_bind', 'sign_in', 'change_number_old', 'change_number_new')),
  subject_id text,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_otp_challenges_phone_idx on public.phone_otp_challenges (phone_key, created_at desc);

-- 9. Knowledge base + learning loop ------------------------------------------
create table if not exists public.property_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  -- Null = applies to the whole team.
  property_id text references public.manager_property_records (id) on delete cascade,
  topic text not null default 'general',
  question text not null check (length(question) between 1 and 500),
  answer text not null check (length(answer) between 1 and 2000),
  status text not null default 'suggested' check (status in ('suggested', 'approved', 'rejected')),
  source text not null check (source in ('manager_answer', 'draft_edit', 'manual', 'import')),
  source_ref text,
  created_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  use_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists property_knowledge_entries_lookup_idx
  on public.property_knowledge_entries (workspace_id, status, property_id);

create table if not exists public.sms_topic_reply_modes (
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  topic text not null,
  mode text not null default 'draft' check (mode in ('draft', 'auto_review', 'full_auto')),
  -- Set by a manager: the automatic promotion never moves past it.
  ceiling text check (ceiling is null or ceiling in ('draft', 'auto_review', 'full_auto')),
  mode_since timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, topic)
);

create table if not exists public.sms_ai_reply_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  topic text not null,
  mode text not null check (mode in ('draft', 'auto_review', 'full_auto')),
  outcome text not null check (outcome in ('sent_as_is', 'edited', 'rejected', 'corrected_after', 'escalated')),
  conversation_id uuid,
  turn_ref text,
  created_at timestamptz not null default now()
);
create index if not exists sms_ai_reply_outcomes_topic_idx
  on public.sms_ai_reply_outcomes (workspace_id, topic, created_at desc);

-- 10. Lock it down -------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'sms_line_sessions', 'sms_line_thread_state', 'sms_line_shadow_decisions',
    'sms_entry_codes', 'sms_unassigned_leads', 'sms_unassigned_lead_turns',
    'sms_phone_contacts', 'sms_media_files', 'phone_bound_links',
    'phone_bound_link_sessions', 'phone_otp_challenges', 'property_knowledge_entries',
    'sms_topic_reply_modes', 'sms_ai_reply_outcomes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
