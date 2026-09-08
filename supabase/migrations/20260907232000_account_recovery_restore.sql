create function public.account_recovery_rewrite_public_assets(p_value jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb:='{}'; k text; v jsonb; text_value text; asset record;
begin
  if jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(public.account_recovery_rewrite_public_assets(value)),'[]') into result from jsonb_array_elements(p_value); return result;
  end if;
  if jsonb_typeof(p_value)='object' then
    for k,v in select * from jsonb_each(p_value) loop result:=result||jsonb_build_object(k,public.account_recovery_rewrite_public_assets(v)); end loop;
    return result;
  end if;
  if jsonb_typeof(p_value)='string' then
    text_value:=p_value #>> '{}';
    for asset in select id,public_url from public.account_recovery_objects where is_public and state in ('retained','active') and public_url<>'' and strpos(text_value,public_url)>0 loop
      text_value:=replace(text_value,asset.public_url,'/api/recovered-assets/'||asset.id::text);
    end loop;
    return to_jsonb(text_value);
  end if;
  return p_value;
end $$;

create function public.account_recovery_restore_reference(p_request uuid,p_record uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; r public.account_recovery_records; h public.account_recovery_holds;
  current_data jsonb; patch jsonb; keys text[]; hashes text[]; assignments text;
begin
  select * into a from public.account_recovery_requests where id=p_request;
  select * into h from public.account_recovery_holds where request_id=p_request and record_id=p_record;
  select * into r from public.account_recovery_records where id=p_record for update;
  if a.decision is distinct from 'recover' or h.decision is distinct from 'recover' then raise exception 'Recovery decision required'; end if;
  if r.erased or h.identity_patch is null then return; end if;
  current_data:=r.payload;
  if not r.archived then
    execute format('select to_jsonb(t) from public.%I t where to_jsonb(t) @> $1 for update',r.table_name) into current_data using r.row_key;
  end if;
  if current_data is null or not (current_data @> (h.identity_patch->'after'))
    or not (current_data @> coalesce(h.identity_patch->'guard_after','{}'))
    or ((h.identity_patch->>'json')::boolean and public.account_recovery_resident_identity(current_data->'row_data') is distinct from h.identity_patch->'json_after')
    or (h.kind='reference' and h.identity_patch ? 'owner' and current_data->'manager_user_id' is distinct from h.identity_patch->'owner') then
    -- A surviving owner reassigned the record. Consume recovery material without
    -- unblocking its old identity or overwriting the new assignment.
    update public.account_recovery_holds set identity_patch=null where request_id=a.id and record_id=r.id;
    return;
  end if;
  patch:=h.identity_patch->'before';
  if (h.identity_patch->>'json')::boolean then
    patch:=patch||jsonb_build_object('row_data',public.account_recovery_rewrite_resident(current_data->'row_data',
      a.id::text,'deleted-'||a.id::text||'@deleted.invalid',a.user_id::text,a.email));
  end if;
  keys:=array(select jsonb_array_elements_text(coalesce(h.identity_patch->'guard_columns','[]')))||case when (h.identity_patch->>'json')::boolean then array['$row_data'] else '{}'::text[] end;
  hashes:=array[public.account_identity_hash(a.user_id::text),public.account_identity_hash(a.email)];
  delete from public.account_deleted_identity_keys where table_name=r.table_name and record_id=r.row_key->>'id'
    and column_name=any(keys) and identity_hash=any(hashes);
  if not r.archived then
    select string_agg(format('%I=(jsonb_populate_record(null::public.%I,$1)).%I',key,r.table_name,key),',') into assignments from jsonb_object_keys(patch) key;
    if assignments is not null then execute format('update public.%I t set %s where to_jsonb(t) @> $2',r.table_name,assignments) using patch,r.row_key; end if;
  end if;
  update public.account_recovery_records set payload=current_data||patch where id=r.id;
  update public.account_recovery_holds set identity_patch=null where request_id=a.id and record_id=r.id;
end $$;

-- Publication is a DATABASE transaction. Retained bytes stay under the same
-- private generation; only the authorized logical mapping becomes active.
create function public.account_recovery_restore_available(p_request uuid,p_claim uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; r record; o record; fk record; columns_sql text; values_sql text; nullable_patch jsonb; restored_payload jsonb; assignments text;
  progress integer; restored integer:=0; waiting integer; unavailable integer; passes integer:=0;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.decision is distinct from 'recover' or p_claim is null or a.claim_id is distinct from p_claim then raise exception 'Recovery claim lost'; end if;
  if not exists(select 1 from auth.users where id=a.user_id and lower(email)=a.email) then raise exception 'Account identity changed'; end if;
  perform set_config('proplane.account_recovery_internal','on',true);
  if exists(select 1 from public.account_recovery_object_holds h join public.account_recovery_objects incomplete_object on incomplete_object.id=h.object_id
    where h.request_id=a.id and incomplete_object.state='copying') then raise exception 'File retention has not completed'; end if;
  -- Identity precedes profile-dependent FKs. Only the selected self-owned role
  -- and allowlisted personal fields return; no provider state or delegated roles.
  if not exists(select 1 from public.profiles where id=a.user_id) then
    insert into public.profiles(id,email,role,full_name,phone,preferred_language) values(a.user_id,a.email,a.portal,a.profile_data->>'full_name',a.profile_data->>'phone',coalesce(a.profile_data->>'preferred_language','en'));
  end if;
  insert into public.profile_roles(user_id,role) values(a.user_id,a.portal) on conflict do nothing;
  for r in select record_id from public.account_recovery_holds where request_id=a.id and kind in ('reference','business') and identity_patch is not null loop
    perform public.account_recovery_restore_reference(a.id,r.record_id);
  end loop;
  drop table if exists pg_temp.recovery_pending;
  drop table if exists pg_temp.recovery_deferred_links;
  create temporary table recovery_deferred_links(record_id uuid,table_name text,row_key jsonb,patch jsonb) on commit drop;
  create temporary table recovery_pending on commit drop as
    select stored.* from public.account_recovery_records stored join public.account_recovery_holds h on h.record_id=stored.id
      where h.request_id=a.id and public.account_recovery_publishable(stored.id);
  loop
    progress:=0; passes:=passes+1;
    for r in select * from recovery_pending order by phase desc,table_name loop
      select string_agg(quote_ident(c.column_name),','),string_agg(format('(jsonb_populate_record(null::public.%I,$1)).%I',r.table_name,c.column_name),',')
        into columns_sql,values_sql from information_schema.columns c where c.table_schema='public' and c.table_name=r.table_name
          and c.is_generated='NEVER' and r.payload ? c.column_name;
      begin
        restored_payload:=public.account_recovery_rewrite_public_assets(r.payload);
        begin
          execute format('insert into public.%I (%s) select %s',r.table_name,columns_sql,values_sql) using restored_payload;
        exception when foreign_key_violation then
          -- Break nullable FK cycles inside this transaction. Required parents
          -- still have to restore; missing optional/revoked parents remain null.
          select coalesce(jsonb_object_agg(col.attname,'null'::jsonb),'{}') into nullable_patch
            from pg_constraint constraint_row join pg_attribute col on col.attrelid=constraint_row.conrelid and col.attnum=any(constraint_row.conkey)
            where constraint_row.contype='f' and constraint_row.conrelid=to_regclass('public.'||quote_ident(r.table_name)) and not col.attnotnull;
          if nullable_patch='{}' then raise; end if;
          execute format('insert into public.%I (%s) select %s',r.table_name,columns_sql,values_sql) using restored_payload||nullable_patch;
          for fk in select constraint_row.oid,jsonb_object_agg(col.attname,restored_payload->col.attname) patch
            from pg_constraint constraint_row join pg_attribute col on col.attrelid=constraint_row.conrelid and col.attnum=any(constraint_row.conkey)
            where constraint_row.contype='f' and constraint_row.conrelid=to_regclass('public.'||quote_ident(r.table_name)) and not col.attnotnull
            group by constraint_row.oid loop
            insert into recovery_deferred_links values(r.id,r.table_name,r.row_key,fk.patch);
          end loop;
          restored_payload:=restored_payload||nullable_patch;
        end;
        update public.account_recovery_records set archived=false,payload=restored_payload where id=r.id;
        delete from recovery_pending where id=r.id;
        progress:=progress+1; restored:=restored+1;
      exception when foreign_key_violation then null;
      end;
    end loop;
    exit when not exists(select 1 from recovery_pending);
    if progress=0 or passes>100 then raise exception 'Related records are unavailable; recovery was not applied'; end if;
  end loop;
  for fk in select * from recovery_deferred_links loop
    select string_agg(format('%I=(jsonb_populate_record(null::public.%I,$1)).%I',key,fk.table_name,key),',') into assignments from jsonb_object_keys(fk.patch) key;
    begin
      execute format('update public.%I t set %s where to_jsonb(t) @> $2',fk.table_name,assignments) using fk.patch,fk.row_key;
      update public.account_recovery_records set payload=payload||fk.patch where id=fk.record_id;
    exception when foreign_key_violation then null;
    end;
  end loop;
  -- A file can be active only when at least one restored record uses it. Files
  -- without record references require every holder's explicit recovery choice.
  for o in select distinct obj.* from public.account_recovery_objects obj join public.account_recovery_object_holds h on h.object_id=obj.id where h.request_id=a.id and obj.state='retained' loop
    if exists(select 1 from public.account_recovery_object_records link join public.account_recovery_records stored on stored.id=link.record_id
      where link.object_id=o.id and not stored.archived and not stored.erased)
      or (not exists(select 1 from public.account_recovery_object_records where object_id=o.id)
        and not exists(select 1 from public.account_recovery_object_holds h join public.account_recovery_requests request on request.id=h.request_id
          where h.object_id=o.id and request.decision is distinct from 'recover')) then
      update public.account_recovery_objects set state='active' where id=o.id;
    end if;
  end loop;
  select count(*) into waiting from public.account_recovery_holds h join public.account_recovery_records stored on stored.id=h.record_id
    where h.request_id=a.id and stored.archived and not stored.erased and stored.recoverable;
  select count(*) into unavailable from public.account_recovery_holds h join public.account_recovery_records stored on stored.id=h.record_id where h.request_id=a.id and stored.erased;
  update public.account_recovery_requests set state='restored',profile_data=null,challenge_hash=null,challenge_until=null where id=a.id;
  -- Completed holds must not grant access to a later deletion of the same row.
  delete from public.account_recovery_holds h using public.account_recovery_records stored where h.record_id=stored.id and not stored.archived and h.decision='recover' and h.identity_patch is null;
  perform public.account_recovery_compact_terminal();
  return jsonb_build_object('restored',restored,'waiting',waiting,'unavailable',unavailable,'portal',a.portal);
end $$;

create function public.account_recovery_recover(p_request uuid,p_user uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare claim uuid;
begin
  claim:=public.account_recovery_choose(p_request,p_user,p_hash,'recover');
  return public.account_recovery_restore_available(p_request,claim);
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
