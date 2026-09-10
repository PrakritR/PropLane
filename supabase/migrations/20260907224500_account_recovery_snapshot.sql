create function public.account_recovery_row_key(p_table text,p_row jsonb)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select jsonb_object_agg(a.attname,p_row->a.attname)
  from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
  where i.indrelid=to_regclass('public.'||quote_ident(p_table)) and i.indisprimary
$$;

create function public.account_recovery_matches(p_row jsonb,p_rule jsonb,p_user uuid,p_email text,p_reference boolean default false)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare col text;
begin
  if p_rule ? 'portal' and p_row->>'portal' is distinct from p_rule->>'portal' then return false; end if;
  if p_rule ? 'scope' and p_row->>'scope' is distinct from p_rule->>'scope' then return false; end if;
  if p_rule ? 'bindingRole' and p_row->>'role' is distinct from p_rule->>'bindingRole' then return false; end if;
  if p_rule ? 'restrict' and p_row->>(p_rule->'restrict'->>'column') is not distinct from p_rule->'restrict'->>'notEquals' then return false; end if;
  for col in select jsonb_array_elements_text(coalesce(p_rule->case when p_reference then 'detachIds' else 'ids' end,'[]')) loop
    if p_row->>col=p_user::text then return true; end if;
  end loop;
  for col in select jsonb_array_elements_text(coalesce(p_rule->case when p_reference then 'detachEmails' else 'emails' end,'[]')) loop
    if nullif(p_email,'') is not null and lower(p_row->>col)=lower(p_email) then return true; end if;
  end loop;
  if not p_reference then
    if coalesce((p_rule->>'retainFinancial')::boolean,false) and public.account_json_has_deleted_identity(p_row->'row_data',array[public.account_identity_hash(p_user::text),public.account_identity_hash(p_email)]) then return true; end if;
    for col in select jsonb_array_elements_text(coalesce(p_rule->'jsonEmails','[]')) loop
      if nullif(p_email,'') is not null and lower(p_row->'row_data'->>col)=lower(p_email) then return true; end if;
    end loop;
  end if;
  return false;
end $$;

-- Called in the same transaction as opening a request. Real rows and already
-- retained rows receive holds, so deleting in either order has the same result.
create function public.account_recovery_snapshot(p_request uuid)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; rule jsonb; selected_record record; tbl text; hold_kind text; key jsonb; n integer:=0;
  fk record; join_sql text; parent record; child record; child_id uuid; progress integer; passes integer:=0;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if not found or a.state<>'archiving' then raise exception 'Retention request is not open'; end if;
  -- Lock in a deterministic order before taking any snapshot. Ordinary writers
  -- cannot insert a new child or alter a selected identity halfway through it.
  for tbl in select tablename from pg_tables where schemaname='public' and tablename not like 'account_recovery_%' order by tablename loop
    execute format('lock table public.%I in share row exclusive mode',tbl);
  end loop;
  for rule in select value from jsonb_array_elements(a.plan->'rules') loop
    tbl:=rule->>'table';
    if tbl !~ '^[a-z_]+$' or (tbl like 'account_recovery_%' or tbl='account_deleted_record_identities') then raise exception 'Invalid archive table'; end if;
    if to_regclass('public.'||quote_ident(tbl)) is null then continue; end if;
    for selected_record in execute format('select to_jsonb(t) payload from public.%I t where public.account_recovery_matches(to_jsonb(t),$1,$2,$3) or public.account_recovery_matches(to_jsonb(t),$1,$2,$3,true) for update',tbl)
      using rule,a.user_id,a.email loop
      key:=public.account_recovery_row_key(tbl,selected_record.payload);
      hold_kind:=case when tbl in ('vendor_invoices','vendor_payouts') then 'business' when coalesce((rule->>'retainFinancial')::boolean,false) or not public.account_recovery_matches(selected_record.payload,rule,a.user_id,a.email) then 'reference' else 'delete' end;
      perform public.account_recovery_add_hold(a.id,tbl,key,selected_record.payload,hold_kind,(rule->>'recover')::boolean,(rule->>'phase')::integer);
      n:=n+1;
    end loop;
    for selected_record in select * from public.account_recovery_records where table_name=tbl and archived and not erased and
      (public.account_recovery_matches(payload,rule,a.user_id,a.email) or public.account_recovery_matches(payload,rule,a.user_id,a.email,true)) loop
      hold_kind:=case when tbl in ('vendor_invoices','vendor_payouts') then 'business' when coalesce((rule->>'retainFinancial')::boolean,false) or not public.account_recovery_matches(selected_record.payload,rule,a.user_id,a.email) then 'reference' else 'delete' end;
      perform public.account_recovery_add_hold(a.id,tbl,selected_record.row_key,selected_record.payload,hold_kind,selected_record.recoverable,selected_record.phase);
      n:=n+1;
    end loop;
  end loop;
  -- Follow destructive FK dependencies only. A financial resident pointer is a
  -- reference, so it never brings the manager's books into this delete closure.
  loop
    progress:=0; passes:=passes+1;
    for fk in select c.conrelid,c.confrelid,c.conkey,c.confkey,tc.relname child_table,tp.relname parent_table
      from pg_constraint c join pg_class tc on tc.oid=c.conrelid join pg_class tp on tp.oid=c.confrelid
      where c.contype='f' and c.confdeltype='c' and tc.relnamespace='public'::regnamespace
        and tp.relnamespace='public'::regnamespace and tc.relname not like 'account_recovery_%' loop
      select string_agg(format('to_jsonb(t)->>%L=$1->>%L',ca.attname,pa.attname),' and ') into join_sql
        from unnest(fk.conkey,fk.confkey) k(ca,pa)
        join pg_attribute ca on ca.attrelid=fk.conrelid and ca.attnum=k.ca
        join pg_attribute pa on pa.attrelid=fk.confrelid and pa.attnum=k.pa;
      for parent in select r.* from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
        where h.request_id=a.id and h.kind='delete' and r.table_name=fk.parent_table and not r.erased loop
        for child in execute format('select to_jsonb(t) payload from public.%I t where %s',fk.child_table,join_sql) using parent.payload loop
          key:=public.account_recovery_row_key(fk.child_table,child.payload);
          if not exists(select 1 from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id where r.table_name=fk.child_table and r.row_key=key and h.request_id=a.id and h.kind='delete') then
            child_id:=public.account_recovery_add_hold(a.id,fk.child_table,key,child.payload,'delete',parent.recoverable and (a.plan->'recoverableTables' ? fk.child_table),parent.phase-1);
            progress:=progress+1;
          else
            select id into child_id from public.account_recovery_records where table_name=fk.child_table and row_key=key;
          end if;
          insert into public.account_recovery_dependencies values(parent.id,child_id) on conflict do nothing;
        end loop;
        -- Already retained children follow the very same deletion dependency.
        for child in select r.* from public.account_recovery_records r join public.account_recovery_dependencies d on d.child_id=r.id where d.parent_id=parent.id and not r.erased loop
          if not exists(select 1 from public.account_recovery_holds where request_id=a.id and record_id=child.id and kind='delete') then
            perform public.account_recovery_add_hold(a.id,child.table_name,child.row_key,child.payload,'delete',child.recoverable,child.phase);
            progress:=progress+1;
          end if;
        end loop;
      end loop;
    end loop;
    exit when progress=0;
    if passes>100 then raise exception 'Retention dependency closure did not converge'; end if;
  end loop;
  -- Plain-text application identifiers are also deletion dependencies.
  for parent in select r.* from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
    where h.request_id=a.id and h.kind='delete' and r.table_name='manager_application_records' and not r.erased loop
    for child in select r.* from public.account_recovery_records r join public.account_recovery_dependencies d on d.child_id=r.id where d.parent_id=parent.id and not r.erased loop
      perform public.account_recovery_add_hold(a.id,child.table_name,child.row_key,child.payload,'delete',child.recoverable,child.phase);
    end loop;
    for tbl in select unnest(array['screening_orders','cosigner_submission_records']) loop
      if to_regclass('public.'||quote_ident(tbl)) is null then continue; end if;
      for child in execute format('select to_jsonb(t) payload from public.%I t where to_jsonb(t)->>%L=$1',tbl,
        case when tbl='screening_orders' then 'application_id' else 'signer_app_id' end) using parent.payload->>'id' loop
        child_id:=public.account_recovery_add_hold(a.id,tbl,public.account_recovery_row_key(tbl,child.payload),child.payload,'delete',false,0);
        insert into public.account_recovery_dependencies values(parent.id,child_id) on conflict do nothing;
      end loop;
    end loop;
  end loop;
  return n;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
