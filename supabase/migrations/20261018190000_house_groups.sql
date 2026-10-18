-- House group chats with an AI RA (one Twilio Conversation per house, group MMS).
-- Spec: docs/agents/one-number.md § W10 · brief: texting-plan-1018 § House group chats.
--
-- Everything is ADDITIVE and service-role only: RLS on, no anon/authenticated grants, so the
-- public PostgREST surface can never read a member list, a consent record or a group message.
-- Groups exist only while the line is shared AND the workspace turned `enabled` on (default off).

-- 1. Per-workspace switch + the daily post cap ----------------------------------------------
create table if not exists public.house_group_settings (
  workspace_id uuid primary key references public.portal_workspaces (id) on delete cascade,
  enabled boolean not null default false,
  max_posts_per_day integer not null default 4 check (max_posts_per_day between 1 and 12),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- 2. One Conversation per house per member list --------------------------------------------
-- A group is DEFINED by its member list: `member_hash` is the digest of the sorted phone keys.
-- A changed list means a new Conversation; the old one is `retired` (kept open so its webhook
-- can reply once to a stray text) and `closed` a month later. A retired group whose list comes
-- back is reactivated rather than duplicated, so two open Conversations never share a member set.
create table if not exists public.house_group_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  property_id text not null references public.manager_property_records (id) on delete cascade,
  conversation_sid text not null unique,
  status text not null default 'active' check (status in ('active', 'retired', 'closed')),
  member_hash text not null,
  superseded_by uuid references public.house_group_conversations (id) on delete set null,
  retired_notice_sent_at timestamptz,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  closed_at timestamptz
);
create unique index if not exists house_group_conversations_one_active
  on public.house_group_conversations (property_id) where status = 'active';
create unique index if not exists house_group_conversations_member_set
  on public.house_group_conversations (property_id, member_hash) where status in ('active', 'retired');
create index if not exists house_group_conversations_workspace_idx
  on public.house_group_conversations (workspace_id, status);

create table if not exists public.house_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.house_group_conversations (id) on delete cascade,
  phone_key text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  resident_user_id uuid references auth.users (id) on delete set null,
  first_name text check (first_name is null or length(first_name) <= 40),
  room_label text check (room_label is null or length(room_label) <= 60),
  participant_sid text,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (group_id, phone_key)
);
create index if not exists house_group_members_phone_idx on public.house_group_members (phone_key);

-- 3. Consent + "leave group" ------------------------------------------------------------------
-- Keyed on (workspace, phone). A resident is added only with `consent_at` set and
-- `opted_out_of_group` false. A global STOP is honoured separately (the opt-out ledger).
create table if not exists public.house_group_preferences (
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  phone_key text not null,
  opted_out_of_group boolean not null default false,
  consent_at timestamptz,
  consent_source text check (consent_source is null or consent_source in ('lease_signature', 'sms_join', 'manager_record')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, phone_key)
);

-- 4. Group message log: webhook dedupe, daily post count, RA state ---------------------------
create table if not exists public.house_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.house_group_conversations (id) on delete cascade,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  property_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- outbound: intro | answer | announcement | reminder | rent_reminder | rules | maintenance | emergency | notice | ...
  kind text not null default 'message',
  author_phone_key text,
  message_sid text,
  idempotency_key text,
  -- Redacted, capped. Never a card or bank number.
  body text not null default '' check (length(body) <= 600),
  -- inbound only: complaint | rule | safety | harassment | discrimination
  flag text check (flag is null or flag in ('complaint', 'rule', 'safety', 'harassment', 'discrimination')),
  -- inbound house-fact question the RA may answer if nobody has by then
  answer_check_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists house_group_messages_sid
  on public.house_group_messages (group_id, message_sid) where message_sid is not null;
create unique index if not exists house_group_messages_idem
  on public.house_group_messages (group_id, idempotency_key) where idempotency_key is not null;
create index if not exists house_group_messages_recent
  on public.house_group_messages (group_id, created_at desc);
create index if not exists house_group_messages_due
  on public.house_group_messages (answer_check_at) where answer_check_at is not null and answered_at is null;

-- 5. Lock it down ------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'house_group_settings', 'house_group_conversations', 'house_group_members',
    'house_group_preferences', 'house_group_messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
