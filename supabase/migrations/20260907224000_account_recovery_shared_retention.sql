-- Service-only coordinator. A record is retained once, even when both parties
-- delete. A reference hold cannot erase the surviving owner's business record.
create table public.account_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text not null,
  portal text not null check (portal in ('manager','resident','vendor')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 days',
  state text not null default 'archiving' check (state in ('archiving','retained','recovering','purging','restored','discarded')),
  decision text check (decision in ('recover','fresh','expire')),
  profile_data jsonb,
  plan jsonb not null,
  challenge_hash text,
  challenge_until timestamptz,
  challenge_sent_at timestamptz,
  claim_id uuid,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  check (expires_at=created_at+interval '30 days')
);
create unique index account_recovery_active_portal on public.account_recovery_requests(user_id,portal)
  where state not in ('restored','discarded');
create index account_recovery_deadline on public.account_recovery_requests(expires_at)
  where state in ('archiving','retained');

create function public.account_recovery_key_hash(p_key jsonb)
returns text language sql immutable strict set search_path=pg_catalog as $$
  select encode(sha256(convert_to(p_key::text,'UTF8')),'hex')
$$;

create table public.account_recovery_records (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_key jsonb,
  row_key_hash text not null,
  payload jsonb,
  archived boolean not null default false,
  erased boolean not null default false,
  recoverable boolean not null,
  phase integer not null,
  check (not erased or payload is null)
);
create unique index account_recovery_live_generation on public.account_recovery_records(table_name,row_key_hash) where not erased;
-- Self-keyed configuration can be created anew after an explicit choice. Its
-- previous generation remains an erased tombstone, never replayed or reused.
create function public.account_recovery_recreatable(p_table text)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select p_table=any(array['manager_automation_settings','manager_billing_settings','manager_tax_profiles',
    'manager_comms_billing_accounts','manager_assistant_emails','manager_sms_numbers','sms_manager_entitlements',
    'notification_preferences','agent_user_preferences','resident_housemate_sharing','sms_consent'])
$$;
create table public.account_recovery_holds (
  request_id uuid not null references public.account_recovery_requests(id),
  record_id uuid not null references public.account_recovery_records(id),
  kind text not null check (kind in ('delete','reference','business')),
  decision text check (decision in ('recover','fresh','expire')),
  identity_patch jsonb,
  identity_detached boolean not null default false,
  primary key (request_id,record_id)
);
-- Only deletion dependencies belong here; incidental person references do not.
create table public.account_recovery_dependencies (
  parent_id uuid not null references public.account_recovery_records(id),
  child_id uuid not null references public.account_recovery_records(id),
  primary key(parent_id,child_id)
);

create function public.account_recovery_open(p_user uuid,p_portal text,p_plan jsonb,p_profile jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare existing uuid; mail text;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select id into existing from public.account_recovery_requests where user_id=p_user and portal=p_portal and state not in ('restored','discarded');
  if found then return existing; end if;
  select lower(email) into mail from auth.users where id=p_user;
  if nullif(mail,'') is null then raise exception 'Account identity unavailable'; end if;
  if p_portal not in ('manager','resident','vendor') then raise exception 'Invalid recovery portal'; end if;
  if not exists(select 1 from public.profile_roles where user_id=p_user and (role=p_portal or (p_portal='manager' and role in ('owner','pro'))))
    and not exists(select 1 from public.profiles where id=p_user and (role=p_portal or (p_portal='manager' and role in ('owner','pro')))) then
    raise exception 'This account does not have access to that portal';
  end if;
  -- Role, permissions, provider secrets and billing configuration never enter
  -- the recoverable profile, even if a caller accidentally passes a full row.
  insert into public.account_recovery_requests(user_id,email,portal,plan,profile_data)
    values(p_user,mail,p_portal,p_plan,
      jsonb_strip_nulls(jsonb_build_object('full_name',p_profile->'full_name','phone',p_profile->'phone','preferred_language',p_profile->'preferred_language'))) returning id into existing;
  return existing;
end $$;

create function public.account_recovery_add_hold(p_request uuid,p_table text,p_key jsonb,p_payload jsonb,p_kind text,p_recoverable boolean,p_phase integer)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; r public.account_recovery_records;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'archiving' or a.expires_at<=now() then raise exception 'Retention request is not open'; end if;
  if p_table !~ '^[a-z_]+$' or p_table like 'account_recovery_%' or jsonb_typeof(p_key) is distinct from 'object' or p_key='{}' then
    raise exception 'Invalid retained record identity';
  end if;
  if p_kind not in ('delete','reference','business') then raise exception 'Invalid retention ownership'; end if;
  if not public.account_recovery_recreatable(p_table) and exists(select 1 from public.account_recovery_records
    where table_name=p_table and row_key_hash=public.account_recovery_key_hash(p_key) and erased) then
    raise exception 'This record generation was permanently erased';
  end if;
  insert into public.account_recovery_records(table_name,row_key,row_key_hash,payload,recoverable,phase)
    values(p_table,p_key,public.account_recovery_key_hash(p_key),p_payload,p_recoverable,p_phase) on conflict(table_name,row_key_hash) where not erased do nothing;
  select * into r from public.account_recovery_records where table_name=p_table and row_key_hash=public.account_recovery_key_hash(p_key) and not erased for update;
  if r.erased then raise exception 'This record generation was permanently erased'; end if;
  -- A live financial row may have changed since an earlier reference hold.
  -- Only the caller's transactionally locked live snapshot can refresh it.
  if not r.archived then
    update public.account_recovery_records set payload=p_payload,recoverable=recoverable and p_recoverable where id=r.id;
  end if;
  insert into public.account_recovery_holds(request_id,record_id,kind) values(a.id,r.id,p_kind)
    on conflict(request_id,record_id) do update set kind=case when account_recovery_holds.kind='delete' or excluded.kind='delete' then 'delete' when account_recovery_holds.kind='business' or excluded.kind='business' then 'business' else 'reference' end;
  return r.id;
end $$;

create function public.account_recovery_issue_challenge(p_request uuid,p_user uuid,p_hash text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid recovery challenge'; end if;
  update public.account_recovery_requests a set challenge_hash=p_hash,
    challenge_until=least(now()+interval '15 minutes',expires_at),challenge_sent_at=now()
    where id=p_request and user_id=p_user and state='retained' and expires_at>now()
      and (challenge_sent_at is null or challenge_sent_at<now()-interval '60 seconds')
      and exists(select 1 from auth.users u where u.id=p_user and lower(u.email)=a.email);
  get diagnostics n=row_count; return n=1;
end $$;

create function public.account_recovery_choose(p_request uuid,p_user uuid,p_hash text,p_choice text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; claim uuid:=gen_random_uuid();
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request and user_id=p_user for update;
  if not found or p_choice is null or p_choice not in ('recover','fresh') then raise exception 'Invalid recovery choice'; end if;
  if not exists(select 1 from auth.users where id=p_user and lower(email)=a.email) then raise exception 'Account identity changed'; end if;
  -- The same confirmed choice is retryable, even after a failed file operation.
  -- The consumed hash is retained only until final cleanup, scoped to this user.
  if a.decision=p_choice and a.claim_id is not null and a.challenge_hash=p_hash then return a.claim_id; end if;
  if a.state<>'retained' or a.decision is not null or a.expires_at<=now() or a.challenge_until is null or a.challenge_until<=now()
    or a.challenge_hash is null or p_hash is null or a.challenge_hash<>p_hash then raise exception 'Recovery link expired or already used'; end if;
  update public.account_recovery_requests set decision=p_choice,claim_id=claim,
    state=case when p_choice='recover' then 'recovering' else 'purging' end,challenge_until=null where id=a.id;
  update public.account_recovery_holds set decision=p_choice where request_id=a.id;
  return claim;
end $$;

create function public.account_recovery_claim_expired(p_limit integer default 20)
returns setof public.account_recovery_requests language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  for a in select * from public.account_recovery_requests where next_attempt_at<=now() and ((state='retained' and decision is null and expires_at<=now()) or (state='purging' and decision='expire'))
    order by attempts,expires_at for update skip locked limit least(greatest(p_limit,1),20) loop
    if a.state='retained' then
      update public.account_recovery_requests set state='purging',decision='expire',claim_id=gen_random_uuid(),challenge_hash=null,challenge_until=null
        where id=a.id returning * into a;
      update public.account_recovery_holds set decision='expire' where request_id=a.id;
    end if;
    return next a;
  end loop;
end $$;

create function public.account_recovery_erase_records(p_request uuid,p_claim uuid)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; n integer;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'purging' or a.decision not in ('fresh','expire') or p_claim is null or a.claim_id is distinct from p_claim then
    raise exception 'Cleanup claim lost';
  end if;
  if exists(select 1 from public.account_recovery_holds h join public.account_recovery_records r on r.id=h.record_id
    where h.request_id=a.id and h.kind in ('reference','business') and not h.identity_detached and not r.erased) then
    raise exception 'Identity detachment has not completed';
  end if;
  with recursive discarded(id) as (
    select h.record_id from public.account_recovery_holds h join public.account_recovery_records r on r.id=h.record_id
      where h.request_id=a.id and (h.kind='delete' or (h.kind='business' and r.archived
        and not exists(select 1 from public.account_recovery_holds other where other.record_id=r.id and other.kind='business' and (other.decision is null or other.decision='recover'))))
    union select d.child_id from public.account_recovery_dependencies d join discarded p on p.id=d.parent_id
  ) update public.account_recovery_records set payload=null,row_key=null,erased=true where id in(select id from discarded) and not erased;
  get diagnostics n=row_count;
  -- Reference patches are recovery material, not ownership of the books.
  update public.account_recovery_holds set identity_patch=null where request_id=a.id;
  return n;
end $$;

create function public.account_recovery_publishable(p_record uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.account_recovery_records r where r.id=p_record and r.archived and not r.erased and r.recoverable
    and ((exists(select 1 from public.account_recovery_holds h where h.record_id=r.id and h.kind='delete')
      and not exists(select 1 from public.account_recovery_holds h where h.record_id=r.id and h.kind='delete' and h.decision is distinct from 'recover'))
    or exists(select 1 from public.account_recovery_holds h where h.record_id=r.id and h.kind='business' and h.decision='recover')))

$$;

do $$ declare t text; f record; begin
  foreach t in array array['account_recovery_requests','account_recovery_records','account_recovery_holds','account_recovery_dependencies'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
