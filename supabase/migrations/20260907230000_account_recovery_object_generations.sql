-- All recovery generations stay in a PRIVATE bucket. Physical paths are never
-- reused: a delayed cleanup can delete only its obsolete generation.
insert into storage.buckets(id,name,public) values('account-recovery','account-recovery',false) on conflict(id) do nothing;
create table public.account_deleted_storage_keys (
  key_hash text primary key
);
-- Physical retirement is permanent even after the logical asset is recovered.
create table public.account_recovery_retired_source_keys (
  key_hash text primary key
);
alter table public.account_deleted_storage_keys enable row level security;
revoke all on public.account_deleted_storage_keys from anon,authenticated;
grant all on public.account_deleted_storage_keys to service_role;
create function public.account_recovery_storage_key(p_bucket text,p_path text)
returns text language sql immutable strict set search_path=pg_catalog as $$
  select encode(sha256(convert_to(jsonb_build_array(p_bucket,p_path)::text,'UTF8')),'hex')
$$;
create table public.account_recovery_objects (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  logical_path text not null,
  public_url text not null,
  source_path text not null,
  source_bucket text not null,
  generation uuid not null default gen_random_uuid(),
  private_path text not null,
  cleanup_attempt_at timestamptz not null default '-infinity',
  state text not null default 'copying' check(state in ('copying','retained','active','purging','purged')),
  copied boolean not null default false,
  source_removed boolean not null default false,
  is_public boolean not null default false,
  unique(bucket,logical_path)
);
create table public.account_recovery_object_holds (
  object_id uuid not null references public.account_recovery_objects(id),
  request_id uuid not null references public.account_recovery_requests(id),
  primary key(object_id,request_id)
);
create table public.account_recovery_object_records (
  object_id uuid not null references public.account_recovery_objects(id),
  record_id uuid not null references public.account_recovery_records(id),
  primary key(object_id,record_id)
);
create function public.account_recovery_inherit_file_holds()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.kind in ('delete','business') then
    insert into public.account_recovery_object_holds
      select object_id,new.request_id from public.account_recovery_object_records where record_id=new.record_id on conflict do nothing;
  end if;
  return new;
end $$;
create trigger account_recovery_inherit_file_holds after insert or update on public.account_recovery_holds for each row execute function public.account_recovery_inherit_file_holds();

-- Retired opaque keys remain eligible for cleanup; they contain no original name
-- or user identifier. A stale worker cannot publish them or make them public.
create table public.account_recovery_retired_objects (
  private_path text primary key,
  retired_at timestamptz not null default now(),
  last_swept_at timestamptz not null default '-infinity'
);

create function public.account_recovery_register_object(p_request uuid,p_bucket text,p_path text,p_encoded text,p_public_url text)
returns public.account_recovery_objects language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; o public.account_recovery_objects; generation_id uuid:=gen_random_uuid();
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'archiving' or not a.snapshot_complete then raise exception 'File retention request unavailable'; end if;
  if p_bucket not in ('application-documents','manager-documents','listing-photos','lease-templates','vendor-documents','portal-inbox-attachments','bug-feedback-attachments','sms-media','inspection-evidence')
    or nullif(p_path,'') is null or p_path ~ '(^|/)[.][.]?(/|$)' then raise exception 'Invalid retention object'; end if;
  if exists(select 1 from public.account_deleted_storage_keys where key_hash=public.account_recovery_storage_key(p_bucket,p_path)) then raise exception 'Object generation was permanently erased'; end if;
  select * into o from public.account_recovery_objects where bucket=p_bucket and logical_path=p_path for update;
  if not found then
    insert into public.account_recovery_objects(bucket,logical_path,public_url,source_bucket,source_path,generation,private_path,is_public)
      values(p_bucket,p_path,p_public_url,p_bucket,p_path,generation_id,generation_id::text||'/bytes',coalesce((select public from storage.buckets where id=p_bucket),false)) returning * into o;
  elsif o.state='active' and exists(
    select 1 from public.account_recovery_object_records link join public.account_recovery_records r on r.id=link.record_id
    where link.object_id=o.id and not r.erased and not r.archived
      and not exists(select 1 from public.account_recovery_holds h join public.account_recovery_requests request on request.id=h.request_id
        where h.record_id=r.id and h.kind='delete' and request.state in ('archiving','retained','recovering','purging'))
  ) then
    -- The surviving owner's live record still authorizes this private generation.
    -- Removing the deleting account's rows removes its access, not these bytes.
    insert into public.account_recovery_object_holds values(o.id,a.id) on conflict do nothing;
    return o;
  elsif o.state='active' then
    -- Re-deletion archives from the active private generation, never a reused
    -- original key. Keep the original logical path as encryption/AAD context.
    delete from public.account_recovery_object_holds h using public.account_recovery_requests request where h.object_id=o.id and request.id=h.request_id and request.state in ('restored','discarded');
    update public.account_recovery_objects set source_bucket='account-recovery',source_path=o.private_path,
      generation=generation_id,private_path=generation_id::text||'/bytes',state='copying',copied=false,source_removed=false where id=o.id returning * into o;
  elsif o.state in ('purging','purged') then raise exception 'Object generation was permanently erased';
  end if;
  insert into public.account_recovery_retired_source_keys values(public.account_recovery_storage_key(p_bucket,p_path)) on conflict do nothing;
  insert into public.account_recovery_object_holds values(o.id,a.id) on conflict do nothing;
  insert into public.account_recovery_object_records
    select o.id,r.id from public.account_recovery_records r where not r.erased
      and (strpos(r.payload::text,p_path)>0 or strpos(r.payload::text,p_encoded)>0) on conflict do nothing;
  insert into public.account_recovery_object_holds
    select o.id,h.request_id from public.account_recovery_holds h join public.account_recovery_object_records linked on linked.record_id=h.record_id
      join public.account_recovery_requests request on request.id=h.request_id
      where linked.object_id=o.id and h.kind in ('delete','business') and request.state in ('archiving','retained','recovering','purging') on conflict do nothing;
  return o;
end $$;

create function public.account_recovery_object_progress(p_object uuid,p_generation uuid,p_copied boolean,p_removed boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
  update public.account_recovery_objects set copied=copied or p_copied,source_removed=source_removed or p_removed,
    state=case when (copied or p_copied) and (source_removed or p_removed) then 'retained' else state end
    where id=p_object and generation=p_generation and state='copying';
  get diagnostics n=row_count;
  if n=1 and p_removed then
    insert into public.account_recovery_retired_objects(private_path) select source_path from public.account_recovery_objects where id=p_object and generation=p_generation and source_bucket='account-recovery' on conflict do nothing;
  end if;
  return n=1;
end $$;

create function public.account_recovery_resolve_object(p_bucket text,p_path text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',id,'state',state,'bucket','account-recovery','path',private_path,'logicalPath',logical_path)
    from public.account_recovery_objects where bucket=p_bucket and logical_path=p_path
$$;

-- Reject metadata publication of obsolete private keys, including delayed
-- copies after their owning generation was purged. There is no public policy.
create function public.account_recovery_storage_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not pg_try_advisory_xact_lock_shared(723081447301::bigint) then
    raise exception 'Account lifecycle transition in progress; retry transaction' using errcode='40001';
  end if;
  if exists(select 1 from public.account_recovery_retired_source_keys where key_hash=public.account_recovery_storage_key(new.bucket_id,new.name)) then raise exception 'Retired physical object key cannot be reused'; end if;
  if exists(select 1 from public.account_deleted_storage_keys where key_hash=public.account_recovery_storage_key(new.bucket_id,new.name)) then raise exception 'Deleted object key cannot be reused'; end if;
  if new.bucket_id<>'account-recovery' and exists(select 1 from public.account_recovery_requests a
    where a.state in ('archiving','retained','recovering','purging') and (
      ((a.portal='manager' or (a.plan->>'complete')::boolean) and (
        (new.bucket_id in ('listing-photos','lease-templates','inspection-evidence') and starts_with(new.name,a.user_id::text||'/'))
        or (new.bucket_id in ('manager-documents','sms-media') and starts_with(new.name,'manager/'||a.user_id::text||'/'))))
      or ((a.portal='vendor' or (a.plan->>'complete')::boolean) and new.bucket_id='vendor-documents' and starts_with(new.name,'vendor-documents/'||a.user_id::text||'/'))
      or ((a.plan->>'complete')::boolean and ((new.bucket_id='portal-inbox-attachments' and starts_with(new.name,a.user_id::text||'/'))
        or (new.bucket_id='bug-feedback-attachments' and starts_with(new.name,'bug-feedback/'||a.user_id::text||'/'))))
      or exists(select 1 from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
        where h.request_id=a.id and h.kind='delete' and (
          (new.bucket_id='application-documents' and r.table_name='manager_application_records' and split_part(new.name,'/',2)=
            case when upper(r.row_key->>'id') like 'AXIS-%' or upper(r.row_key->>'id') like 'PROPLANE-%'
              then regexp_replace(upper(r.row_key->>'id'),'[^A-Z0-9_-]','_','g')
              else 'PROPLANE-'||left(regexp_replace(upper(r.row_key->>'id'),'[^A-Z0-9]','','g'),12) end)
          or (new.bucket_id='inspection-evidence' and r.table_name='resident_inspections' and starts_with(new.name,(r.payload->>'manager_user_id')||'/'||(r.row_key->>'id')||'/'))
        ))
    )) then raise exception 'Account recovery decision required for uploads'; end if;
  if new.bucket_id='account-recovery' and not exists(select 1 from public.account_recovery_objects
    where private_path=new.name and state in ('copying','retained','active')) then raise exception 'Recovery object generation is retired'; end if;
  return new;
end $$;
create trigger account_recovery_storage_guard before insert or update on storage.objects for each row execute function public.account_recovery_storage_guard();

do $$ declare t text; f record; begin
  foreach t in array array['account_recovery_retired_source_keys','account_recovery_objects','account_recovery_object_holds','account_recovery_object_records','account_recovery_retired_objects'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
