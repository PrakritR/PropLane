-- Facebook Page replies: one auto-reply per (Page, sender) per 24h.
-- Service role only (the Messenger webhook). No client grant, no client policy.
-- Additive and idempotent.

create table if not exists public.meta_messenger_replies (
  page_id text not null,
  sender_psid text not null,
  replied_at timestamptz not null default now(),
  listing_id text,
  manager_user_id uuid references auth.users (id) on delete cascade,
  workspace_id uuid references public.portal_workspaces (id) on delete cascade,
  primary key (page_id, sender_psid)
);

create index if not exists meta_messenger_replies_manager_idx
  on public.meta_messenger_replies (manager_user_id);

alter table public.meta_messenger_replies enable row level security;

revoke all on table public.meta_messenger_replies from anon, authenticated;
grant all on table public.meta_messenger_replies to service_role;
