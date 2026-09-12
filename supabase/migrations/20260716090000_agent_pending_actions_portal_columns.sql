-- Multi-portal columns for the agent write-action gate.
--
-- The table itself is created by 20260713000000_agent_pending_actions.sql and
-- is claimed on `user_id` + status 'proposed' (see src/lib/tools/pending-actions.ts).
-- This migration only WIDENS it so resident and vendor proposals can live in
-- the same table and be traced back to their chat session.
--
-- An earlier revision of this file renamed `user_id` to `actor_user_id` for a
-- competing write-action framework that was never shipped. That rename is
-- removed on purpose: `user_id` is the live claim key in both the dev and
-- production databases, and renaming it would break every confirm-gated write
-- (including the two production SMS agents) the moment it was pushed.

alter table public.agent_pending_actions add column if not exists portal text not null default 'manager';
alter table public.agent_pending_actions
  add column if not exists session_id uuid references public.agent_sessions (id) on delete set null;

create index if not exists agent_pending_actions_actor_idx
  on public.agent_pending_actions (user_id, status, created_at desc);

-- Sessions/messages now serve all three portals. `landlord_id` remains the
-- scope column: the manager id for manager sessions, the actor's own user id
-- for resident/vendor sessions. `portal` records which surface the session
-- belongs to.
alter table public.agent_sessions add column if not exists portal text not null default 'manager';
alter table public.agent_messages add column if not exists portal text not null default 'manager';
