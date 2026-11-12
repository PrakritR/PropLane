-- Prospect spine (design-1112 section 2.5, Package A). Additive and idempotent. Every table here is service-role only:
-- RLS on, no policy, no client grant (trust tables; see AGENTS.md "PostgREST surface").
--
--   * sms_phone_contacts gains the prospect's claims (email), the proof stamp (verified_at: set only by an OTP or
--     phone_auth_bind), the first source and the link time. The row is still keyed on the phone.
--   * prospect_contexts: one row per (person or platform handle) x workspace x property x room x source.
--   * sms_reply_handles / sms_listing_flows: manage-by-text state keyed on a staff phone (Package C reads them).
--   * merge_inbox_thread_row_data: one atomic jsonb merge on a thread row (the spine's stamps and delivery issues).
--   * phone_bound_links.purpose gains 'account'; phone_otp_challenges.purpose gains 'listing_message'.

alter table public.sms_phone_contacts
  add column if not exists email text,
  add column if not exists verified_at timestamptz,
  add column if not exists first_source text,
  add column if not exists linked_at timestamptz;

create table if not exists public.prospect_contexts (
  id uuid primary key default gen_random_uuid(),
  phone_key text,
  contact_handle text,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  property_id text references public.manager_property_records (id) on delete set null,
  room_id text,
  room_label text,
  source text not null check (source in ('sms','listing_message','in_app','application','tour','voice',
    'spareroom','roomies','facebook','zillow','craigslist','roomster','airbnb','booking_com','padsplit','other')),
  source_ref text,
  thread_id text,
  channel_state text not null default 'active' check (channel_state in ('active','moved')),
  moved_at timestamptz,
  stitch_code text unique check (stitch_code is null or stitch_code ~ '^[A-Z0-9]{4,8}$'),
  first_message_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (phone_key is not null or contact_handle is not null)
);
create unique index if not exists prospect_contexts_identity on public.prospect_contexts
  (workspace_id, coalesce(phone_key,''), coalesce(contact_handle,''), coalesce(property_id,''), coalesce(room_id,''), source);
create index if not exists prospect_contexts_phone_idx on public.prospect_contexts (phone_key) where phone_key is not null;
create index if not exists prospect_contexts_property_idx on public.prospect_contexts (workspace_id, property_id, source);
alter table public.prospect_contexts enable row level security;
revoke all on public.prospect_contexts from anon, authenticated;

create table if not exists public.sms_reply_handles (
  id uuid primary key default gen_random_uuid(),
  staff_phone_key text not null,
  handle text not null check (handle ~ '^[A-Z0-9]{2,4}$'),
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  thread_id text not null,
  counterparty_phone_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (staff_phone_key, handle)
);
create index if not exists sms_reply_handles_expiry_idx on public.sms_reply_handles (expires_at);
alter table public.sms_reply_handles enable row level security;
revoke all on public.sms_reply_handles from anon, authenticated;

create table if not exists public.sms_listing_flows (
  staff_phone_key text primary key,
  workspace_id uuid not null references public.portal_workspaces (id) on delete cascade,
  step text not null check (step in ('address','rooms','rent','details','confirm','photos')),
  draft jsonb not null default '{}'::jsonb,
  property_id text references public.manager_property_records (id) on delete set null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.sms_listing_flows enable row level security;
revoke all on public.sms_listing_flows from anon, authenticated;

-- One atomic merge on a thread row's row_data: keys in p_patch are set, keys named in p_remove are dropped. Used by the
-- spine for stamps (prospectContext, rootHouseId) and delivery issues so two writers never overwrite each other's turns.
create or replace function public.merge_inbox_thread_row_data(
  p_thread_id text,
  p_owner uuid,
  p_patch jsonb,
  p_remove text[] default '{}'
) returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row_data jsonb;
  v_key text;
begin
  if nullif(p_thread_id, '') is null or p_owner is null or jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid thread merge';
  end if;
  select row_data into v_row_data from public.portal_inbox_thread_records
    where id = p_thread_id and owner_user_id = p_owner for update;
  if not found then
    return false;
  end if;
  v_row_data := coalesce(v_row_data, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb);
  foreach v_key in array coalesce(p_remove, '{}') loop
    v_row_data := v_row_data - v_key;
  end loop;
  update public.portal_inbox_thread_records set row_data = v_row_data where id = p_thread_id and owner_user_id = p_owner;
  return true;
end;
$$;
revoke all on function public.merge_inbox_thread_row_data(text, uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.merge_inbox_thread_row_data(text, uuid, jsonb, text[]) to service_role;

-- Restate each allowed purpose list as the UNION of the live constraint and the values known here, so this migration
-- can never narrow a list another branch widened.
do $$
declare
  existing text[] := '{}';
  def text;
  wanted text[] := array['gallery','tour','application','lease','rent','move_in','job','payouts','account'];
  merged text[];
  list text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    where c.conrelid = 'public.phone_bound_links'::regclass and c.conname = 'phone_bound_links_purpose_check';
  if def is not null then
    select coalesce(array_agg(m[1]), '{}') into existing from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  end if;
  select array_agg(distinct v order by v) into merged from unnest(existing || wanted) as v;
  select string_agg(quote_literal(v), ', ') into list from unnest(merged) as v;
  alter table public.phone_bound_links drop constraint if exists phone_bound_links_purpose_check;
  execute format('alter table public.phone_bound_links add constraint phone_bound_links_purpose_check check (purpose in (%s))', list);
end $$;

do $$
declare
  existing text[] := '{}';
  def text;
  wanted text[] := array['link_unlock','public_bind','sign_in','change_number_old','change_number_new','sms_signup','service_manager','listing_message'];
  merged text[];
  list text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    where c.conrelid = 'public.phone_otp_challenges'::regclass and c.conname = 'phone_otp_challenges_purpose_check';
  if def is not null then
    select coalesce(array_agg(m[1]), '{}') into existing from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  end if;
  select array_agg(distinct v order by v) into merged from unnest(existing || wanted) as v;
  select string_agg(quote_literal(v), ', ') into list from unnest(merged) as v;
  alter table public.phone_otp_challenges drop constraint if exists phone_otp_challenges_purpose_check;
  execute format('alter table public.phone_otp_challenges add constraint phone_otp_challenges_purpose_check check (purpose in (%s))', list);
end $$;
