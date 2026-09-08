-- Conditional identity edits are shared between the live row and its single
-- retained generation. Financial values are never replayed from a snapshot.
create function public.account_recovery_rewrite_resident(p_value jsonb,p_old_id text,p_old_email text,p_new_id text,p_new_email text)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare k text; v jsonb; result jsonb:='{}';
begin
  if jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(public.account_recovery_rewrite_resident(value,p_old_id,p_old_email,p_new_id,p_new_email)),'[]') into result from jsonb_array_elements(p_value);
    return result;
  end if;
  if jsonb_typeof(p_value) is distinct from 'object' then return p_value; end if;
  for k,v in select * from jsonb_each(p_value) loop
    if k in ('residentUserId','resident_user_id') and nullif(p_old_id,'') is not null and v #>> '{}' = p_old_id then v:=to_jsonb(p_new_id);
    elsif k in ('residentEmail','resident_email') and nullif(p_old_email,'') is not null and lower(v #>> '{}')=lower(p_old_email) then v:=to_jsonb(p_new_email);
    elsif jsonb_typeof(v) in ('object','array') then v:=public.account_recovery_rewrite_resident(v,p_old_id,p_old_email,p_new_id,p_new_email);
    end if;
    result:=result||jsonb_build_object(k,v);
  end loop;
  return result;
end $$;

-- Compare identity only: a manager can change amounts/status without losing the
-- recovery link, but reassignment of resident fields must never be reversed.
create function public.account_recovery_resident_identity(p_value jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare result jsonb:='{}'; k text; v jsonb;
begin
  if jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(public.account_recovery_resident_identity(value)),'[]') into result from jsonb_array_elements(p_value);
    return result;
  end if;
  if jsonb_typeof(p_value) is distinct from 'object' then return '{}'::jsonb; end if;
  for k,v in select * from jsonb_each(p_value) loop
    if k in ('residentUserId','resident_user_id','residentEmail','resident_email') then result:=result||jsonb_build_object(k,v);
    elsif jsonb_typeof(v) in ('object','array') then result:=result||jsonb_build_object(k,public.account_recovery_resident_identity(v)); end if;
  end loop;
  return result;
end $$;

create function public.account_recovery_detach_reference(p_request uuid,p_record uuid,p_ids text[],p_emails text[],p_financial boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; r public.account_recovery_records; before_data jsonb; patch jsonb:='{}'; before_patch jsonb:='{}';
  c text; assignments text; alias text; hashes text[];
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'archiving' then raise exception 'Retention request is not open'; end if;
  select * into r from public.account_recovery_records where id=p_record for update;
  if not found or r.erased or not exists(select 1 from public.account_recovery_holds where request_id=a.id and record_id=r.id and kind in ('reference','business')) then raise exception 'Reference hold unavailable'; end if;
  if exists(select 1 from public.account_recovery_holds where request_id=a.id and record_id=r.id and identity_patch is not null) then return; end if;
  before_data:=r.payload;
  if not r.archived then
    execute format('select to_jsonb(t) from public.%I t where to_jsonb(t) @> $1 for update',r.table_name) into before_data using r.row_key;
    if before_data is null then raise exception 'Referenced record changed before retention'; end if;
  end if;
  alias:='deleted-'||a.id::text||'@deleted.invalid';
  foreach c in array p_ids loop
    if before_data->>c=a.user_id::text then patch:=patch||jsonb_build_object(c,null); before_patch:=before_patch||jsonb_build_object(c,before_data->c); end if;
  end loop;
  foreach c in array p_emails loop
    if lower(before_data->>c)=a.email then patch:=patch||jsonb_build_object(c,alias); before_patch:=before_patch||jsonb_build_object(c,before_data->c); end if;
  end loop;
  if before_data ? 'row_data' then
    patch:=patch||jsonb_build_object('row_data',public.account_recovery_rewrite_resident(before_data->'row_data',a.user_id::text,a.email,a.id::text,alias));
  end if;
  if p_financial then
    hashes:=array[public.account_identity_hash(a.user_id::text),public.account_identity_hash(a.email)];
    insert into public.account_deleted_record_identities(table_name,record_id,identity_hashes,id_columns,email_columns)
      values(r.table_name,r.payload->>'id',hashes,p_ids,p_emails)
      on conflict(table_name,record_id) do update set
        identity_hashes=(select array_agg(distinct v) from unnest(account_deleted_record_identities.identity_hashes||excluded.identity_hashes) v),
        id_columns=coalesce((select array_agg(distinct v) from unnest(account_deleted_record_identities.id_columns||excluded.id_columns) v),'{}'),
        email_columns=coalesce((select array_agg(distinct v) from unnest(account_deleted_record_identities.email_columns||excluded.email_columns) v),'{}');
    perform public.account_recovery_block_identity_keys(r.table_name,r.payload->>'id',p_ids,p_emails,hashes);
  end if;
  if not r.archived then
    select string_agg(format('%I=(jsonb_populate_record(null::public.%I,$1)).%I',key,r.table_name,key),',') into assignments from jsonb_object_keys(patch) key;
    if assignments is not null then execute format('update public.%I t set %s where to_jsonb(t) @> $2',r.table_name,assignments) using patch,r.row_key; end if;
  end if;
  update public.account_recovery_records set payload=before_data||patch where id=r.id;
  update public.account_recovery_holds set identity_detached=true,identity_patch=jsonb_build_object('json_after',public.account_recovery_resident_identity(patch->'row_data'),'guard_after',(select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(before_data||patch) where key=any(p_ids||p_emails)),'guard_columns',to_jsonb(p_ids||p_emails),'owner',before_data->'manager_user_id','before',before_patch,'after',patch-'row_data','marker',a.id,'json',before_data ? 'row_data')
    where request_id=a.id and record_id=r.id;
  if not r.archived and r.table_name in ('vendor_invoices','vendor_payouts') then
    execute format('delete from public.%I t where to_jsonb(t) @> $1 and manager_user_id is null and vendor_user_id is null',r.table_name) using r.row_key;
  end if;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
