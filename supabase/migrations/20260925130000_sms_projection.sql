-- Additive, replayable SMS Communication projection.
-- Operational transport tables remain the source evidence; these rows are a
-- bounded read model with immutable event bodies and service-only writes.

create table if not exists public.sms_projection_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_manager_user_id uuid not null references auth.users(id) on delete cascade,
  counterparty_role text not null check (counterparty_role in ('prospect','resident','applicant','vendor','manager','admin','unknown')),
  -- Deliberately no FK: a released/deleted provider number row is still part
  -- of historical identity and must not be nulled or reassigned to a new epoch.
  work_line_id uuid not null,
  identity_key text not null,
  identity_kind text not null check (identity_kind in ('phone','user','unresolved')),
  counterparty_user_id uuid references auth.users(id) on delete set null,
  counterparty_phone text,
  work_line_phone text not null,
  legacy_conversation_key text,
  last_body text not null default '',
  last_direction text check (last_direction in ('inbound','outbound')),
  last_event_at timestamptz,
  last_event_id uuid,
  last_inbound_at timestamptz,
  last_inbound_event_id uuid,
  event_count bigint not null default 0 check (event_count >= 0),
  metadata jsonb not null default '{}'::jsonb,
  merged_into_id uuid references public.sms_projection_conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_manager_user_id, counterparty_role, work_line_id, identity_key)
);

create index if not exists sms_projection_conversations_owner_last_idx
  on public.sms_projection_conversations(owner_manager_user_id, last_event_at desc, id desc);
create index if not exists sms_projection_conversations_line_identity_idx
  on public.sms_projection_conversations(work_line_id, counterparty_role, identity_key);

create table if not exists public.sms_projection_turns (
  id uuid primary key default gen_random_uuid(),
  owner_manager_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.sms_projection_conversations(id) on delete cascade,
  source_namespace text not null,
  source_event_id text not null,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null,
  occurred_at timestamptz not null,
  from_phone text,
  to_phone text,
  source_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(owner_manager_user_id, source_namespace, source_event_id)
);
create index if not exists sms_projection_turns_conversation_cursor_idx
  on public.sms_projection_turns(conversation_id, occurred_at desc, id desc);

create table if not exists public.sms_projection_aliases (
  id uuid primary key default gen_random_uuid(),
  owner_manager_user_id uuid not null references auth.users(id) on delete cascade,
  counterparty_role text not null check (counterparty_role in ('prospect','resident','applicant','vendor','manager','admin','unknown')),
  work_line_id uuid not null,
  alias_kind text not null check (alias_kind in ('legacy_key','legacy_thread')),
  alias_value text not null,
  conversation_id uuid not null references public.sms_projection_conversations(id) on delete cascade,
  source_owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(owner_manager_user_id, counterparty_role, work_line_id, alias_kind, alias_value)
);
create index if not exists sms_projection_aliases_conversation_idx
  on public.sms_projection_aliases(conversation_id);

create table if not exists public.sms_projection_pending (
  id uuid primary key default gen_random_uuid(),
  owner_manager_user_id uuid not null references auth.users(id) on delete cascade,
  source_namespace text not null,
  source_event_id text not null,
  event_payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','completed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  claim_token uuid,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_manager_user_id,source_namespace,source_event_id)
);
create index if not exists sms_projection_pending_due_idx
  on public.sms_projection_pending(status,next_attempt_at,created_at);

-- Archive and read progress belong to a viewer within an authorized owner.
-- Callers resolve property/co-manager visibility before the CAS RPC below.
create table if not exists public.sms_projection_view_state (
  viewer_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.sms_projection_conversations(id) on delete cascade,
  is_archived boolean not null default false,
  read_through_at timestamptz,
  read_through_event_id uuid,
  version bigint not null default 1 check(version > 0),
  updated_at timestamptz not null default now(),
  primary key(viewer_user_id,conversation_id),
  check ((read_through_at is null) = (read_through_event_id is null))
);
create index if not exists sms_projection_view_state_conversation_idx
  on public.sms_projection_view_state(conversation_id,viewer_user_id);

alter table public.sms_projection_conversations enable row level security;
alter table public.sms_projection_turns enable row level security;
alter table public.sms_projection_aliases enable row level security;
alter table public.sms_projection_pending enable row level security;
alter table public.sms_projection_view_state enable row level security;
revoke all on public.sms_projection_conversations, public.sms_projection_turns, public.sms_projection_aliases, public.sms_projection_pending, public.sms_projection_view_state from anon, authenticated;
grant all on public.sms_projection_conversations, public.sms_projection_turns, public.sms_projection_aliases, public.sms_projection_pending, public.sms_projection_view_state to service_role;

create or replace function public.project_sms_conversation_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := nullif(p_event->>'ownerManagerUserId','')::uuid;
  v_role text := p_event->>'counterpartyRole';
  v_line uuid := nullif(p_event->>'workLineId','')::uuid;
  v_identity text := p_event->>'identityKey';
  v_kind text := p_event->>'identityKind';
  v_phone text := nullif(p_event->>'counterpartyPhone','');
  v_from text := nullif(p_event->>'fromPhone','');
  v_to text := nullif(p_event->>'toPhone','');
  v_direction text := p_event->>'direction';
  v_body text := p_event->>'body';
  v_occurred timestamptz := (p_event->>'occurredAt')::timestamptz;
  v_namespace text := p_event->>'sourceNamespace';
  v_source_id text := p_event->>'sourceEventId';
  v_conversation public.sms_projection_conversations%rowtype;
  v_turn_id uuid;
  v_inserted boolean := false;
  v_alias_kind text;
  v_alias_value text;
  v_existing uuid;
  v_line_matches integer;
  v_line_phone text;
  v_prior public.sms_projection_turns%rowtype;
  v_prior_conversation public.sms_projection_conversations%rowtype;
  v_target public.sms_projection_conversations%rowtype;
begin
  if v_owner is null or v_line is null or v_role is null or v_role not in ('prospect','resident','applicant','vendor','manager','admin','unknown')
     or v_identity is null or v_identity = '' or v_kind is null or v_kind not in ('phone','user','unresolved')
     or v_direction is null or v_direction not in ('inbound','outbound') or v_body is null or v_occurred is null
     or v_namespace is null or v_namespace = '' or v_source_id is null or v_source_id = '' then
    raise exception 'invalid sms projection event' using errcode = '22023';
  end if;
  if v_role='unknown' and (v_kind <> 'unresolved' or v_identity <> 'unresolved:' || v_source_id) then
    raise exception 'unknown SMS identity must be exact event scoped' using errcode='22023';
  end if;
  select count(*),min(n.phone_number) into v_line_matches,v_line_phone from public.manager_sms_numbers n
    where n.id = v_line and n.manager_user_id = v_owner and n.provision_state in ('active','released')
      and coalesce(n.provisioned_at,n.requested_at) <= v_occurred
      and (n.released_at is null or v_occurred <= n.released_at)
      and (n.phone_number = v_from or n.phone_number = v_to);
  if v_line_matches <> 1 then
    raise exception 'sms projection work line is not active for owner and event pair' using errcode = '42501';
  end if;

  -- An exact original provider event may resolve an isolated unknown routing
  -- placeholder. The event bytes and original wire pair must match exactly;
  -- names, current directory data, and phone-only aliases cannot promote it.
  select * into v_prior from public.sms_projection_turns
    where owner_manager_user_id=v_owner and source_namespace=v_namespace and source_event_id=v_source_id;
  if found then
    select * into v_prior_conversation from public.sms_projection_conversations where id=v_prior.conversation_id for update;
    if v_prior_conversation.owner_manager_user_id=v_owner and v_prior_conversation.work_line_id=v_line
       and v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_key=v_identity
       and v_prior_conversation.identity_kind=v_kind and v_prior.body=v_body
       and v_prior.direction=v_direction and v_prior.occurred_at=v_occurred
       and v_prior.from_phone is not distinct from v_from and v_prior.to_phone is not distinct from v_to then
      -- A replay cannot rewrite summary metadata, names, aliases, or chronology.
      return jsonb_build_object('conversationId',v_prior_conversation.id,'turnId',v_prior.id,'inserted',false,'eventCount',v_prior_conversation.event_count);
    end if;
    if v_prior_conversation.owner_manager_user_id=v_owner
       and v_prior_conversation.work_line_id=v_line
       and ((v_prior_conversation.counterparty_role='unknown' and v_prior_conversation.identity_kind='unresolved')
         or (v_prior_conversation.counterparty_role=v_role and v_prior_conversation.identity_kind in ('phone','unresolved') and v_kind='user'))
       and v_prior.body=v_body and v_prior.direction=v_direction and v_prior.occurred_at=v_occurred
       and v_prior.from_phone is not distinct from v_from and v_prior.to_phone is not distinct from v_to
       and (v_role <> 'unknown' or v_kind <> 'unresolved' or v_identity <> v_prior_conversation.identity_key) then
      select * into v_target from public.sms_projection_conversations
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and identity_key=v_identity
          and id<>v_prior_conversation.id and merged_into_id is null for update;
      if found then
        -- A source SID proves this single event, never a fuzzy whole-thread
        -- merge. Unknown placeholders are required to hold only that SID.
        if v_prior_conversation.event_count<>1 or
           (select count(*) from public.sms_projection_turns where conversation_id=v_prior_conversation.id)<>1 then
          raise exception 'unknown SMS placeholder contains more than the proven event' using errcode='23505';
        end if;
        update public.sms_projection_turns set conversation_id=v_target.id where id=v_prior.id;
        update public.sms_projection_conversations c set
          event_count=event_count+1,
          last_body=case when (c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id)) then v_body else c.last_body end,
          last_direction=case when (c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id)) then v_direction else c.last_direction end,
          last_event_at=greatest(coalesce(c.last_event_at,v_occurred),v_occurred),
          last_event_id=case when c.last_event_at is null or (v_occurred,v_prior.id)>(c.last_event_at,c.last_event_id) then v_prior.id else c.last_event_id end,
          last_inbound_at=case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_prior.id)>(c.last_inbound_at,c.last_inbound_event_id)) then v_occurred else c.last_inbound_at end,
          last_inbound_event_id=case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_prior.id)>(c.last_inbound_at,c.last_inbound_event_id)) then v_prior.id else c.last_inbound_event_id end,
          updated_at=now()
          where c.id=v_target.id returning * into v_target;
        insert into public.sms_projection_view_state(viewer_user_id,conversation_id,is_archived,read_through_at,read_through_event_id)
          select viewer_user_id,v_target.id,is_archived,read_through_at,read_through_event_id
          from public.sms_projection_view_state where conversation_id=v_prior_conversation.id
          on conflict(viewer_user_id,conversation_id) do update set
            is_archived=public.sms_projection_view_state.is_archived or excluded.is_archived,
            read_through_at=case when excluded.read_through_at is not null and
              (public.sms_projection_view_state.read_through_at is null or
               (excluded.read_through_at,excluded.read_through_event_id)>(public.sms_projection_view_state.read_through_at,public.sms_projection_view_state.read_through_event_id))
              then excluded.read_through_at else public.sms_projection_view_state.read_through_at end,
            read_through_event_id=case when excluded.read_through_at is not null and
              (public.sms_projection_view_state.read_through_at is null or
               (excluded.read_through_at,excluded.read_through_event_id)>(public.sms_projection_view_state.read_through_at,public.sms_projection_view_state.read_through_event_id))
              then excluded.read_through_event_id else public.sms_projection_view_state.read_through_event_id end,
            version=public.sms_projection_view_state.version+1,updated_at=now();
        update public.sms_projection_conversations set merged_into_id=v_target.id,event_count=0,updated_at=now() where id=v_prior_conversation.id;
        v_conversation := v_target;
      else
      update public.sms_projection_conversations set
        counterparty_role=v_role, identity_key=v_identity, identity_kind=v_kind,
        counterparty_user_id=nullif(p_event->>'counterpartyUserId','')::uuid,
        counterparty_phone=coalesce(v_phone,counterparty_phone),
        updated_at=now()
        where id=v_prior_conversation.id;
      update public.sms_projection_aliases set counterparty_role=v_role
        where conversation_id=v_prior_conversation.id and counterparty_role='unknown';
      select * into v_conversation from public.sms_projection_conversations where id=v_prior_conversation.id;
      end if;
      foreach v_alias_kind in array array['legacy_key','legacy_thread'] loop
        v_alias_value := case when v_alias_kind='legacy_key' then nullif(p_event->>'legacyConversationKey','') else nullif(p_event->>'legacyThreadId','') end;
        if v_alias_value is not null then
          insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
          values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
          on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
          select conversation_id into v_existing from public.sms_projection_aliases
            where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
          if v_existing is distinct from v_conversation.id then raise exception 'sms alias collision' using errcode='23505'; end if;
        end if;
      end loop;
      return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_prior.id,'inserted',false,'eventCount',v_conversation.event_count);
    end if;
  end if;

  insert into public.sms_projection_conversations(
    owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,
    counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,metadata
  ) values (
    v_owner,v_role,v_line,v_identity,v_kind,
    nullif(p_event->>'counterpartyUserId','')::uuid,v_phone,v_line_phone,
    nullif(p_event->>'legacyConversationKey',''),
    case when jsonb_typeof(p_event->'metadata') = 'object' then p_event->'metadata' else '{}'::jsonb end
  ) on conflict(owner_manager_user_id,counterparty_role,work_line_id,identity_key)
    do update set
      counterparty_user_id = coalesce(public.sms_projection_conversations.counterparty_user_id, excluded.counterparty_user_id),
      counterparty_phone = coalesce(excluded.counterparty_phone, public.sms_projection_conversations.counterparty_phone),
      legacy_conversation_key = coalesce(public.sms_projection_conversations.legacy_conversation_key, excluded.legacy_conversation_key),
      metadata = public.sms_projection_conversations.metadata || excluded.metadata,
      updated_at = now()
  returning * into v_conversation;

  insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,source_event_id,direction,body,occurred_at,from_phone,to_phone,source_ref)
  values(v_owner,v_conversation.id,v_namespace,v_source_id,v_direction,v_body,v_occurred,v_from,v_to,
    case when jsonb_typeof(p_event->'sourceRef') = 'object' then p_event->'sourceRef' else '{}'::jsonb end)
  on conflict(owner_manager_user_id,source_namespace,source_event_id) do nothing returning id into v_turn_id;
  v_inserted := v_turn_id is not null;
  if not v_inserted then
    select id,conversation_id into v_turn_id,v_existing from public.sms_projection_turns
      where owner_manager_user_id=v_owner and source_namespace=v_namespace and source_event_id=v_source_id;
    select * into v_prior from public.sms_projection_turns where id=v_turn_id;
    if v_existing is distinct from v_conversation.id or v_prior.body is distinct from v_body
       or v_prior.direction is distinct from v_direction or v_prior.occurred_at is distinct from v_occurred
       or v_prior.from_phone is distinct from v_from or v_prior.to_phone is distinct from v_to then
      raise exception 'sms source event already belongs to another conversation' using errcode = '23505';
    end if;
  else
    update public.sms_projection_conversations c set
      event_count = event_count + 1,
      last_body = case when (c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id)) then v_body else c.last_body end,
      last_direction = case when (c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id)) then v_direction else c.last_direction end,
      last_event_at = greatest(coalesce(c.last_event_at,v_occurred),v_occurred),
      last_event_id = case when c.last_event_at is null or (v_occurred,v_turn_id) > (c.last_event_at,c.last_event_id) then v_turn_id else c.last_event_id end,
      last_inbound_at = case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_turn_id) > (c.last_inbound_at,c.last_inbound_event_id)) then v_occurred else c.last_inbound_at end,
      last_inbound_event_id = case when v_direction='inbound' and (c.last_inbound_at is null or (v_occurred,v_turn_id) > (c.last_inbound_at,c.last_inbound_event_id)) then v_turn_id else c.last_inbound_event_id end,
      updated_at = now()
    where c.id=v_conversation.id returning * into v_conversation;
  end if;

  foreach v_alias_kind in array array['legacy_key','legacy_thread'] loop
    v_alias_value := case when v_alias_kind='legacy_key' then nullif(p_event->>'legacyConversationKey','') else nullif(p_event->>'legacyThreadId','') end;
    if v_alias_value is not null then
      insert into public.sms_projection_aliases(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value,conversation_id,source_owner_id)
      values(v_owner,v_role,v_line,v_alias_kind,v_alias_value,v_conversation.id,v_owner)
      on conflict(owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value) do nothing;
      select conversation_id into v_existing from public.sms_projection_aliases
        where owner_manager_user_id=v_owner and counterparty_role=v_role and work_line_id=v_line and alias_kind=v_alias_kind and alias_value=v_alias_value;
      if v_existing is distinct from v_conversation.id then raise exception 'sms alias collision' using errcode='23505'; end if;
    end if;
  end loop;
  return jsonb_build_object('conversationId',v_conversation.id,'turnId',v_turn_id,'inserted',v_inserted,'eventCount',v_conversation.event_count);
end;
$$;
revoke all on function public.project_sms_conversation_event(jsonb) from public, anon, authenticated;
grant execute on function public.project_sms_conversation_event(jsonb) to service_role;

create or replace function public.claim_sms_projection_retries(p_limit integer default 25)
returns table(owner_manager_user_id uuid,source_namespace text,source_event_id text,event_payload jsonb,attempts integer,next_attempt_at timestamptz,claim_token uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select q.id from public.sms_projection_pending q
    where (q.status='pending' and q.next_attempt_at <= now())
       or (q.status='processing' and q.claimed_until < now())
    order by q.next_attempt_at,q.created_at
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,25),100))
  ), claimed as (
    update public.sms_projection_pending q set status='processing',claimed_until=now()+interval '2 minutes',claim_token=gen_random_uuid(),updated_at=now()
    from due where q.id=due.id returning q.*
  )
  select c.owner_manager_user_id,c.source_namespace,c.source_event_id,c.event_payload,c.attempts,c.next_attempt_at,c.claim_token from claimed c;
end;
$$;
revoke all on function public.claim_sms_projection_retries(integer) from public, anon, authenticated;
grant execute on function public.claim_sms_projection_retries(integer) to service_role;

create or replace function public.finish_sms_projection_retry(p_owner uuid,p_namespace text,p_source_id text,p_claim_token uuid,p_success boolean,p_error_code text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sms_projection_pending q set
    status=case when p_success then 'completed' else 'pending' end,
    attempts=attempts+1,
    next_attempt_at=case when p_success then next_attempt_at else now()+make_interval(secs => least(21600,30 * power(2,least(attempts,9))::integer)) end,
    claimed_until=null,
    claim_token=null,
    last_error_code=case when p_success then null else left(coalesce(p_error_code,'projection_error'),80) end,
    updated_at=now()
  where q.owner_manager_user_id=p_owner and q.source_namespace=p_namespace and q.source_event_id=p_source_id and q.status='processing' and q.claim_token=p_claim_token and q.claimed_until > now();
  return found;
end;
$$;
revoke all on function public.finish_sms_projection_retry(uuid,text,text,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_sms_projection_retry(uuid,text,text,uuid,boolean,text) to service_role;

create or replace function public.set_sms_projection_view_state(
  p_owner uuid,p_viewer uuid,p_conversation uuid,p_expected_version bigint,
  p_archived boolean,p_read_through_at timestamptz,p_read_through_event_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_version bigint;
begin
  if not exists(select 1 from public.sms_projection_conversations c where c.id=p_conversation and c.owner_manager_user_id=p_owner) then
    raise exception 'sms projection conversation not found' using errcode='P0002';
  end if;
  if p_expected_version=0 then
    insert into public.sms_projection_view_state(viewer_user_id,conversation_id,is_archived,read_through_at,read_through_event_id)
      values(p_viewer,p_conversation,p_archived,p_read_through_at,p_read_through_event_id)
      on conflict(viewer_user_id,conversation_id) do nothing returning version into v_version;
    if v_version is not null then return v_version; end if;
  end if;
  update public.sms_projection_view_state s set
    is_archived=p_archived,
    read_through_at=case when p_read_through_at is not null and
      (s.read_through_at is null or (s.read_through_at,s.read_through_event_id) <= (p_read_through_at,p_read_through_event_id))
      then p_read_through_at else s.read_through_at end,
    read_through_event_id=case when p_read_through_at is not null and
      (s.read_through_at is null or (s.read_through_at,s.read_through_event_id) <= (p_read_through_at,p_read_through_event_id))
      then p_read_through_event_id else s.read_through_event_id end,
    version=s.version+1,updated_at=now()
    where s.viewer_user_id=p_viewer and s.conversation_id=p_conversation and s.version=p_expected_version
    returning version into v_version;
  return v_version;
end;
$$;
revoke all on function public.set_sms_projection_view_state(uuid,uuid,uuid,bigint,boolean,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.set_sms_projection_view_state(uuid,uuid,uuid,bigint,boolean,timestamptz,uuid) to service_role;

comment on table public.sms_projection_conversations is 'Normalized SMS Communication summaries. Identity includes immutable owner, role, work-number row and server-resolved identity key.';
comment on table public.sms_projection_turns is 'Append-only original SMS events; one row per namespaced source event.';
comment on table public.sms_projection_aliases is 'Legacy references are scoped by owner, role, and exact work-number row; aliases are lookup aids, never authorization.';
comment on table public.sms_projection_pending is 'Durable service-only projection retries. Replays only the projection, never the SMS provider or paid agent turn.';
