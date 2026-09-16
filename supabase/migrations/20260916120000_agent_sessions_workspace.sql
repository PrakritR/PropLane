-- Portal assistant chats are per manager per workspace. Null is the default
-- workspace (legacy rows). Listing filters on this column; RLS still scopes
-- by user_id via the service-role actor, not this field.
alter table public.agent_sessions
  add column if not exists workspace_id uuid;

create index if not exists agent_sessions_portal_chat_workspace_idx
  on public.agent_sessions (user_id, portal, workspace_id, updated_at desc)
  where kind = 'portal_chat';
