create function public.account_recovery_finish_archival(p_request uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; remaining text; legacy text;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if a.state='retained' then return; end if;
  if not found or a.state<>'archiving' or not a.snapshot_complete then raise exception 'Retention request unavailable'; end if;
  if exists(select 1 from public.account_recovery_holds h join public.account_recovery_records r on r.id=h.record_id where h.request_id=a.id and h.kind='delete' and not r.archived) then raise exception 'Personal record cleanup incomplete'; end if;
  if exists(select 1 from public.account_recovery_holds h where h.request_id=a.id and h.kind in ('reference','business') and h.identity_patch is null) then raise exception 'Identity detachment incomplete'; end if;
  if exists(select 1 from public.account_recovery_object_holds h join public.account_recovery_objects o on o.id=h.object_id where h.request_id=a.id and o.state='copying') then raise exception 'File retention incomplete'; end if;
  perform set_config('proplane.account_recovery_internal','on',true);
  select role into legacy from public.profiles where id=a.user_id;
  if legacy is not null then insert into public.profile_roles(user_id,role) values(a.user_id,legacy) on conflict do nothing; end if;
  delete from public.profile_roles where user_id=a.user_id and (role=a.portal or (a.portal='manager' and role in ('manager','owner','pro')));
  select role into remaining from public.profile_roles where user_id=a.user_id order by role limit 1;
  if remaining is null then delete from public.profiles where id=a.user_id;
  else update public.profiles set role=remaining where id=a.user_id; end if;
  update auth.users set raw_user_meta_data=case when remaining is null then '{}'::jsonb else raw_user_meta_data-'role' end where id=a.user_id;
  with recursive revoked(id) as (
    select r.id from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
      where h.request_id=a.id and r.archived and not r.recoverable
    union select d.child_id from public.account_recovery_dependencies d join revoked parent on parent.id=d.parent_id
  ) update public.account_recovery_records set erased=true,payload=null,row_key=null where id in(select id from revoked);
  update public.account_recovery_requests set state='retained' where id=a.id;
end $$;

create function public.account_recovery_prepare_object_purge(p_request uuid,p_claim uuid)
returns setof public.account_recovery_objects language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'purging' or a.claim_id is distinct from p_claim or p_claim is null then raise exception 'Cleanup claim lost'; end if;
  perform public.account_recovery_erase_records(a.id,p_claim);
  return query update public.account_recovery_objects o set state='purging' where o.id in (
    select h.object_id from public.account_recovery_object_holds h where h.request_id=a.id
      and not exists(select 1 from public.account_recovery_object_records link join public.account_recovery_records r on r.id=link.record_id where link.object_id=h.object_id and not r.erased)

  ) and o.state in ('retained','purging') returning o.*;
end $$;

create function public.account_recovery_finish_object_purge(p_object uuid,p_generation uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.account_recovery_objects;
begin
  select * into o from public.account_recovery_objects where id=p_object and generation=p_generation for update;
  if not found or o.state not in ('purging','purged') then return false; end if;
  insert into public.account_recovery_retired_objects(private_path) values(o.private_path) on conflict do nothing;
  if o.state<>'purged' then
    insert into public.account_deleted_storage_keys values(public.account_recovery_storage_key(o.bucket,o.logical_path)) on conflict do nothing;
    if o.source_bucket='account-recovery' then insert into public.account_recovery_retired_objects(private_path) values(o.source_path) on conflict do nothing; end if;
  end if;
  update public.account_recovery_objects set state='purged',bucket='retired',logical_path=id::text,
    source_bucket='account-recovery',source_path=private_path,public_url='',is_public=false where id=o.id;
  return true;
end $$;

create function public.account_recovery_finish_purge(p_request uuid,p_claim uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'purging' or a.claim_id is distinct from p_claim or p_claim is null then raise exception 'Cleanup claim lost'; end if;
  if exists(select 1 from public.account_recovery_object_holds h join public.account_recovery_objects o on o.id=h.object_id where h.request_id=a.id and o.state in ('copying','purging')) then raise exception 'File cleanup incomplete'; end if;
  perform set_config('proplane.account_recovery_internal','on',true);
  if (a.decision='fresh' or (a.decision='expire' and a.expires_at<=now()))
    and not exists(select 1 from public.profiles where id=a.user_id)
    and not exists(select 1 from public.profile_roles where user_id=a.user_id)
    and not exists(select 1 from public.account_recovery_requests where user_id=a.user_id and id<>a.id and state in ('archiving','retained','recovering','purging')) then
    delete from auth.users where id=a.user_id and lower(email)=a.email;
  end if;
  update public.account_recovery_requests set state='discarded',profile_data=null,plan='{}',challenge_hash=null,challenge_until=null,email='',user_id=null where id=a.id;
  perform public.account_recovery_compact_terminal();
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Called only after an existing file route authorizes its original logical path.
-- Normal deletion of a recovered attachment must erase its actual private bytes.
create function public.account_recovery_prepare_file_removal(p_bucket text,p_path text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.account_recovery_objects;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into o from public.account_recovery_objects where bucket=p_bucket and logical_path=p_path for update;
  if not found then return null; end if;
  if o.state='copying' then
    if not o.copied then raise exception 'File archival has not completed'; end if;
    -- The manifest is removing an obsolete source, already durably copied.
    return null;
  end if;
  if o.state='retained' then raise exception 'Retained attachment is unavailable'; end if;
  if o.state not in ('active','purging') then return null; end if;
  update public.account_recovery_objects set state='purging' where id=o.id;
  return jsonb_build_object('id',o.id,'generation',o.generation,'path',o.private_path);
end $$;
revoke all on function public.account_recovery_prepare_file_removal(text,text) from public,anon,authenticated;
grant execute on function public.account_recovery_prepare_file_removal(text,text) to service_role;

-- Keep only material still needed by a pending shared recovery. Hashed erased
-- generations and private logical mappings remain; redundant personal copies do not.
create function public.account_recovery_compact_terminal()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  update public.account_recovery_holds h set identity_patch=null
    from public.account_recovery_records r where r.id=h.record_id and r.erased;
  delete from public.account_recovery_holds h using public.account_recovery_records r,public.account_recovery_requests a
    where h.record_id=r.id and h.request_id=a.id and a.state in ('restored','discarded')
      and not r.archived and h.identity_patch is null;
  update public.account_recovery_records r set payload=null where not r.archived and not exists(
    select 1 from public.account_recovery_holds h where h.record_id=r.id);
  update public.account_recovery_requests a set user_id=null,email='',plan='{}',profile_data=null,
    challenge_hash=null,challenge_until=null,claim_id=null
    where a.state in ('restored','discarded') and not exists(
      select 1 from public.account_recovery_holds h join public.account_recovery_records r on r.id=h.record_id
      where h.request_id=a.id and ((r.archived and not r.erased) or h.identity_patch is not null));
end $$;
revoke all on function public.account_recovery_compact_terminal() from public,anon,authenticated;
grant execute on function public.account_recovery_compact_terminal() to service_role;
