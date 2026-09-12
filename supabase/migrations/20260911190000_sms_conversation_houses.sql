-- Which house(s) a Communication thread is about.
--
-- One work number is shared by a whole workspace, so what each member SEES has
-- to be decided per thread by the houses they hold. That needs every thread to
-- carry its house(s). Tags come from a record (residency, tour, application),
-- an explicit leasing-agent match, an outbound sent from a house context, or a
-- human — never from a guess, because a wrong tag shows a thread to the wrong
-- member. `source` records which so a manual tag can outrank the rest.
--
-- Keyed on `conversation_key` (owner:role:person) — the durable identity the
-- read path already groups by — so a tag survives renames, phone re-formatting
-- and message deletes. Service-role only, like every other SMS table.

create table if not exists public.manager_sms_conversation_houses (
  manager_user_id   uuid not null references auth.users (id) on delete cascade,
  conversation_key  text not null,
  property_id       text not null,
  source            text not null check (source in ('residency', 'leasing', 'tour', 'application', 'outbound', 'manual')),
  tagged_by_user_id uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  primary key (conversation_key, property_id)
);

create index if not exists manager_sms_conversation_houses_owner_idx
  on public.manager_sms_conversation_houses (manager_user_id, conversation_key);

alter table public.manager_sms_conversation_houses enable row level security;
revoke all on table public.manager_sms_conversation_houses from anon, authenticated;
-- No policies on purpose: default-deny for anon/authenticated PostgREST.

-- Backfill from outbound sends that already named a house: a text sent from a
-- resident's row or a listing's leads is the one existing signal with a real
-- property id attached.
insert into public.manager_sms_conversation_houses (manager_user_id, conversation_key, property_id, source)
select distinct o.manager_user_id, o.conversation_key, o.property_id, 'outbound'
from public.sms_outbox o
where o.conversation_key is not null
  and o.property_id is not null
  and o.property_id <> ''
on conflict do nothing;
