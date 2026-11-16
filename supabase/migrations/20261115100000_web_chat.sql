-- Web chat (captain, Nov 15): an anonymous visitor on a listing page types to the PropLane assistant with no account and
-- no phone code. The visitor is a signed httpOnly cookie id (never a name, email or phone); this table binds that id to ONE
-- conversation per workspace and records the one fact that can merge it into a text thread: a phone the visitor PROVED with
-- the texted code. Messages themselves live in the one manager inbox store (prospect spine), never here.
-- Additive and idempotent. Service role only: RLS on, no client grants. No account column: a visitor is not an account.
create table if not exists public.web_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  workspace_id text not null,
  property_id text,
  room_id text,
  thread_id text,
  phone_e164 text,
  phone_verified_at timestamptz,
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint web_chat_sessions_visitor_workspace_key unique (visitor_id, workspace_id)
);
create index if not exists web_chat_sessions_property_idx on public.web_chat_sessions (visitor_id, property_id);
create index if not exists web_chat_sessions_phone_idx on public.web_chat_sessions (phone_e164) where phone_e164 is not null;
create index if not exists web_chat_sessions_seen_idx on public.web_chat_sessions (last_seen_at);
alter table public.web_chat_sessions enable row level security;
revoke all on public.web_chat_sessions from anon, authenticated;

-- A web visitor is a prospect source and an assistant session kind of its own.
do $$
declare
  existing text[] := '{}';
  def text;
  wanted text[] := array['sms','listing_message','in_app','application','tour','voice','spareroom','roomies','facebook','zillow','craigslist','roomster','airbnb','booking_com','padsplit','other','web_chat'];
  merged text[];
  list text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    where c.conrelid = 'public.prospect_contexts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%listing_message%';
  if def is not null then
    select coalesce(array_agg(m[1]), '{}') into existing from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  end if;
  select array_agg(distinct v order by v) into merged from unnest(existing || wanted) as v;
  select string_agg(quote_literal(v), ', ') into list from unnest(merged) as v;
  for def in select c.conname from pg_constraint c
    where c.conrelid = 'public.prospect_contexts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%listing_message%' loop
    execute format('alter table public.prospect_contexts drop constraint %I', def);
  end loop;
  execute format('alter table public.prospect_contexts add constraint prospect_contexts_source_check check (source in (%s))', list);
end $$;

alter table public.agent_sessions drop constraint if exists agent_sessions_directory_identity_check;
alter table public.agent_sessions add constraint agent_sessions_directory_identity_check check (
  user_id is not null
  or (kind = 'vendor_work_order' and vendor_directory_id is not null)
  or (kind = any (array['leasing_sms', 'leasing_email', 'leasing_web', 'resident_email', 'vendor_line_sms'])
      and landlord_id is not null and nullif(btrim(vendor_phone_e164), '') is not null)
);
create unique index if not exists agent_sessions_leasing_web_identity_uidx
  on public.agent_sessions (landlord_id, vendor_phone_e164)
  where kind = 'leasing_web' and vendor_phone_e164 is not null;
