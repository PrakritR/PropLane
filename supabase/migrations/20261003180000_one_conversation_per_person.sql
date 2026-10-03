-- One conversation per person per workspace (comms-safety-0929, Part B).
--
-- Additive only. A person-thread now carries the identity it belongs to:
--   conversation_key  acct:<uuid> | tel:+E164 | mail:<email> | ws:<workspace uuid>
--   workspace_id      the workspace the conversation lives in
-- and exactly one row may exist per (owner, workspace, scope, key). Rows written
-- before this migration keep a NULL key and are folded by the resumable backfill
-- (scripts/merge-conversations-backfill.mjs); the unique index ignores them.
--
-- Nothing here is reachable by clients: RLS stays on with the existing deny
-- policy, and the functions are executable by the service role only.

alter table public.portal_inbox_thread_records add column if not exists conversation_key text;
alter table public.portal_inbox_thread_records add column if not exists workspace_id uuid;

-- Owner rows: one conversation per (owner, workspace, scope, key).
create unique index if not exists portal_inbox_thread_conversation_uidx
  on public.portal_inbox_thread_records (owner_user_id, workspace_id, scope, conversation_key)
  where conversation_key is not null and workspace_id is not null and owner_user_id is not null;

-- Owner-less (not yet signed up) recipients are matched by participant_email.
create index if not exists portal_inbox_thread_conversation_participant_idx
  on public.portal_inbox_thread_records (lower(participant_email), workspace_id, conversation_key)
  where conversation_key is not null and owner_user_id is null;

-- Old thread ids stay reachable after two threads fold into one (tour links,
-- deep links, archive state).
create table if not exists public.portal_inbox_thread_aliases (
  alias_id text primary key,
  thread_id text not null references public.portal_inbox_thread_records(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists portal_inbox_thread_aliases_thread_idx
  on public.portal_inbox_thread_aliases (thread_id);
alter table public.portal_inbox_thread_aliases enable row level security;
revoke all on public.portal_inbox_thread_aliases from anon, authenticated;
grant all on public.portal_inbox_thread_aliases to service_role;

-- The same key rides on the SMS projection so a text and an in-app message about
-- one person join on it instead of on a browser-side email guess.
alter table public.sms_projection_conversations add column if not exists conversation_key text;
alter table public.sms_projection_conversations add column if not exists workspace_id uuid;
create index if not exists sms_projection_conversations_conversation_key_idx
  on public.sms_projection_conversations (owner_manager_user_id, workspace_id, conversation_key)
  where conversation_key is not null;

-- resolve_or_create_conversation: the ONLY way a person-thread is created.
--
-- p_keys is ordered strongest identity first. Under a per-(owner, workspace)
-- advisory lock it returns the existing row for any of those keys (upgrading its
-- stored key to the strongest), or inserts p_row_data as p_thread_id. Two
-- concurrent creates therefore yield exactly one row; the loser gets the
-- winner's id back with created = false and appends to it.
create or replace function public.resolve_or_create_conversation(
  p_owner uuid,
  p_workspace uuid,
  p_keys text[],
  p_scope text,
  p_thread_id text,
  p_participant_email text,
  p_thread_type text,
  p_row_data jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.portal_inbox_thread_records%rowtype;
  v_email text := lower(nullif(btrim(coalesce(p_participant_email, '')), ''));
  v_strongest text;
begin
  if p_workspace is null or p_keys is null or coalesce(array_length(p_keys, 1), 0) = 0
     or nullif(btrim(coalesce(p_scope, '')), '') is null
     or nullif(btrim(coalesce(p_thread_id, '')), '') is null
     or p_row_data is null or jsonb_typeof(p_row_data) <> 'object'
     or (p_owner is null and v_email is null) then
    raise exception 'Invalid conversation request' using errcode = '22023';
  end if;
  v_strongest := p_keys[1];

  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(p_owner::text, 'mail:' || v_email) || ':' || p_workspace::text, 0)
  );

  select * into v_row
    from public.portal_inbox_thread_records
   where scope = p_scope
     and workspace_id = p_workspace
     and conversation_key = any(p_keys)
     and ((p_owner is not null and owner_user_id = p_owner)
          or (p_owner is null and owner_user_id is null and lower(participant_email) = v_email))
   order by array_position(p_keys, conversation_key), updated_at desc, id
   limit 1;

  if found then
    if v_row.conversation_key is distinct from v_strongest then
      update public.portal_inbox_thread_records
         set conversation_key = v_strongest
       where id = v_row.id
         and not exists (
           select 1 from public.portal_inbox_thread_records other
            where other.id <> v_row.id
              and other.scope = v_row.scope
              and other.workspace_id = v_row.workspace_id
              and other.conversation_key = v_strongest
              and other.owner_user_id is not distinct from v_row.owner_user_id
              and (v_row.owner_user_id is not null
                   or lower(other.participant_email) = v_email));
    end if;
    return jsonb_build_object('id', v_row.id, 'created', false);
  end if;

  insert into public.portal_inbox_thread_records
    (id, scope, owner_user_id, participant_email, thread_type, row_data,
     conversation_key, workspace_id, updated_at)
  values
    (p_thread_id, p_scope, p_owner, nullif(btrim(coalesce(p_participant_email, '')), ''),
     nullif(p_thread_type, ''), p_row_data, v_strongest, p_workspace, clock_timestamp())
  on conflict (id) do nothing;
  if not found then
    raise exception 'Conversation id is already taken' using errcode = '23505';
  end if;
  return jsonb_build_object('id', p_thread_id, 'created', true);
end;
$$;

-- adopt_conversation: stamp an existing (legacy) row with its key + workspace
-- under the same lock. A row that already holds the key elsewhere is reported,
-- never overwritten or merged here (the backfill owns merges).
create or replace function public.adopt_conversation(
  p_thread_id text,
  p_workspace uuid,
  p_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.portal_inbox_thread_records%rowtype;
  v_other text;
begin
  if nullif(btrim(coalesce(p_thread_id, '')), '') is null or p_workspace is null
     or nullif(btrim(coalesce(p_key, '')), '') is null then
    raise exception 'Invalid conversation adoption' using errcode = '22023';
  end if;
  select * into v_row from public.portal_inbox_thread_records where id = p_thread_id;
  if not found then
    return jsonb_build_object('adopted', false, 'reason', 'missing');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(coalesce(v_row.owner_user_id::text,
                              'mail:' || lower(coalesce(v_row.participant_email, ''))) || ':' || p_workspace::text, 0)
  );
  select * into v_row from public.portal_inbox_thread_records where id = p_thread_id for update;
  if v_row.conversation_key = p_key and v_row.workspace_id = p_workspace then
    return jsonb_build_object('adopted', true, 'id', v_row.id);
  end if;
  select id into v_other
    from public.portal_inbox_thread_records other
   where other.id <> v_row.id
     and other.scope = v_row.scope
     and other.workspace_id = p_workspace
     and other.conversation_key = p_key
     and other.owner_user_id is not distinct from v_row.owner_user_id
     and (v_row.owner_user_id is not null
          or lower(other.participant_email) = lower(coalesce(v_row.participant_email, '')))
   limit 1;
  if v_other is not null then
    return jsonb_build_object('adopted', false, 'reason', 'key_taken', 'id', v_other);
  end if;
  update public.portal_inbox_thread_records
     set conversation_key = p_key, workspace_id = p_workspace
   where id = v_row.id;
  return jsonb_build_object('adopted', true, 'id', v_row.id);
end;
$$;

-- stamp_sms_projection_conversation: put the key on a projection summary.
create or replace function public.stamp_sms_projection_conversation(
  p_conversation_id uuid,
  p_workspace uuid,
  p_key text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_conversation_id is null or p_workspace is null or nullif(btrim(coalesce(p_key, '')), '') is null then
    raise exception 'Invalid projection stamp' using errcode = '22023';
  end if;
  update public.sms_projection_conversations
     set conversation_key = p_key, workspace_id = p_workspace
   where id = p_conversation_id
     and (conversation_key is distinct from p_key or workspace_id is distinct from p_workspace);
  return found;
end;
$$;

revoke all on function public.resolve_or_create_conversation(uuid, uuid, text[], text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_or_create_conversation(uuid, uuid, text[], text, text, text, text, jsonb)
  to service_role;
revoke all on function public.adopt_conversation(text, uuid, text) from public, anon, authenticated;
grant execute on function public.adopt_conversation(text, uuid, text) to service_role;
revoke all on function public.stamp_sms_projection_conversation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.stamp_sms_projection_conversation(uuid, uuid, text) to service_role;
