-- A renamed work email's OLD local part is held as a released alias for 30
-- days before any other workspace may claim it (security-review finding on
-- the promote gate, Sep 2026).
--
-- `manager_assistant_emails_mailbox_local_uniq` only constrains ACTIVE rows,
-- and `setWorkspaceAssistantMailboxLocal` renames the SAME row in place
-- (updates `mailbox_local`, never inserts a new row), so the instant a
-- workspace renames its work email the old local part is held by nobody and
-- any other workspace can claim it — and start receiving mail senders still
-- address to the previous owner.
--
-- Additive and idempotent. Service role only: no client-role policy is
-- created and both client roles are explicitly revoked, the same posture as
-- `workspace_automation_settings` — RLS being enabled blocks every row
-- without needing a predicate to get right.
create table if not exists public.manager_assistant_email_aliases (
  mailbox_local text primary key,
  assistant_email_id uuid not null references public.manager_assistant_emails(id) on delete cascade,
  owner_user_id uuid not null,
  released_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.manager_assistant_email_aliases enable row level security;
revoke all on public.manager_assistant_email_aliases from public, anon, authenticated;
grant all on public.manager_assistant_email_aliases to service_role;

-- No client-role policy exists on this table today; this is a placeholder so
-- a future policy addition follows the repo's idempotent-migration rule
-- (drop before create) rather than needing to be discovered fresh.
drop policy if exists manager_assistant_email_aliases_service_only on public.manager_assistant_email_aliases;

create index if not exists manager_assistant_email_aliases_expires_at_idx
  on public.manager_assistant_email_aliases (expires_at);

comment on table public.manager_assistant_email_aliases is
  'A work-email local part released by a rename, held for RELEASED_MAILBOX_ALIAS_DAYS (30) before another workspace may claim it. Read and written only by src/lib/manager-assistant-email/*.server.ts; service role only, never a client role.';
