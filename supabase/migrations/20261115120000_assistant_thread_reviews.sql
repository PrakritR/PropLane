-- Assistant quality management on a conversation (captain, Nov 15): a manager or admin flags an assistant reply, writes
-- what the answer should have been (a correction), and pauses or resumes the assistant on one conversation.
-- Additive and idempotent. Service-role only (RLS on, no anon/authenticated grants): every read and write goes through a
-- route that re-derives the viewer's access to the workspace and the conversation.
--
--   kind = 'flag'       the assistant reply `message_ref` was wrong; `reason` says why. `resolved_at` closes it.
--   kind = 'correction' what the answer should have been (`body`). Also written as an approved
--                       `property_knowledge_entries` row (`knowledge_entry_id`) so the assistant READS it as house
--                       knowledge through lookup_property_knowledge. It is data the assistant quotes, never an instruction.
--   kind = 'pause'      the assistant does not auto-reply on this conversation while the row is open (`resolved_at` null).
--                       `thread_key` is the conversation id, `sms:<10-digit phone>` or `web:<session>`.

create table if not exists public.assistant_thread_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  owner_user_id uuid not null,
  thread_key text not null check (length(thread_key) between 1 and 200),
  kind text not null check (kind in ('flag', 'correction', 'pause')),
  message_ref text check (message_ref is null or length(message_ref) <= 200),
  reason text check (reason is null or length(reason) <= 500),
  body text check (body is null or length(body) <= 2000),
  agent_text text check (agent_text is null or length(agent_text) <= 2000),
  knowledge_entry_id uuid references public.property_knowledge_entries (id) on delete set null,
  created_by_user_id uuid,
  resolved_by_user_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists assistant_thread_reviews_thread_idx
  on public.assistant_thread_reviews (workspace_id, thread_key, created_at desc);

-- One open pause per conversation; a flag may repeat on different messages.
create unique index if not exists assistant_thread_reviews_open_pause_uniq
  on public.assistant_thread_reviews (workspace_id, thread_key)
  where kind = 'pause' and resolved_at is null;

-- The "Assistant review" list: open flags and open pauses of a workspace.
create index if not exists assistant_thread_reviews_open_idx
  on public.assistant_thread_reviews (workspace_id, kind, created_at desc)
  where resolved_at is null;

alter table public.assistant_thread_reviews enable row level security;
revoke all on public.assistant_thread_reviews from anon, authenticated;
grant all on public.assistant_thread_reviews to service_role;
