alter table public.account_recovery_requests add column snapshot_complete boolean not null default false;

create function public.account_recovery_begin(p_user uuid,p_portal text,p_plan jsonb,p_profile jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare request_id uuid; a public.account_recovery_requests; held_record record; rule jsonb; detach_ids text[]; detach_emails text[]; financial boolean;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  request_id:=public.account_recovery_open(p_user,p_portal,p_plan,p_profile);
  select * into a from public.account_recovery_requests where id=request_id for update;
  if a.snapshot_complete then return a.id; end if;
  perform set_config('proplane.account_recovery_internal','on',true);
  perform public.account_recovery_snapshot(a.id);
  for held_record in select r.id,r.table_name,r.payload from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id where h.request_id=a.id and h.kind in ('reference','business') loop
    detach_ids:='{}'; detach_emails:='{}'; financial:=false;
    for rule in select value from jsonb_array_elements(a.plan->'rules') where value->>'table'=held_record.table_name loop
      if public.account_recovery_matches(held_record.payload,rule,a.user_id,a.email,true)
        or (coalesce((rule->>'retainFinancial')::boolean,false) and public.account_recovery_matches(held_record.payload,rule,a.user_id,a.email,false)) then
        detach_ids:=detach_ids||array(select jsonb_array_elements_text(coalesce(rule->'detachIds','[]')||case when coalesce((rule->>'retainFinancial')::boolean,false) then coalesce(rule->'ids','[]') else '[]'::jsonb end));
        detach_emails:=detach_emails||array(select jsonb_array_elements_text(coalesce(rule->'detachEmails','[]')||case when coalesce((rule->>'retainFinancial')::boolean,false) then coalesce(rule->'emails','[]') else '[]'::jsonb end));
        financial:=financial or coalesce((rule->>'retainFinancial')::boolean,false);
      end if;
    end loop;
    perform public.account_recovery_detach_reference(a.id,held_record.id,
      array(select distinct unnest(detach_ids)),array(select distinct unnest(detach_emails)),financial);
  end loop;
  update public.account_recovery_requests set snapshot_complete=true where id=a.id;
  return a.id;
end $$;

-- The ordinary manifest remains responsible for purge order and side effects.
-- Its deletes are captured into the already-frozen shared generation.
create function public.account_recovery_capture_delete()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare retained_id uuid; private_hold boolean;
begin
  select r.id into retained_id from public.account_recovery_records r where r.table_name=TG_TABLE_NAME and r.row_key=public.account_recovery_row_key(TG_TABLE_NAME,to_jsonb(old)) and not r.erased
    and exists(select 1 from public.account_recovery_holds h join public.account_recovery_requests a on a.id=h.request_id
      where h.record_id=r.id and h.kind in ('delete','business') and a.state='archiving');
  if found then
    select exists(select 1 from public.account_recovery_holds where record_id=retained_id and kind='delete') into private_hold;
    -- Private rows are frozen; their snapshot retains links that referential
    -- SET NULL actions remove during purge. Business rows keep the latest money.
    update public.account_recovery_records set payload=case when private_hold then payload else to_jsonb(old) end,archived=true where id=retained_id;
  end if;
  return old;
end $$;

create function public.account_recovery_write_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare before_row jsonb; after_row jsonb; before_key jsonb; after_key jsonb; a record; rule jsonb; captured boolean; cascade_fk record; null_columns text[];
begin
  if current_setting('proplane.account_recovery_internal',true)='on' then
    if TG_OP='DELETE' then return old; else return new; end if;
  end if;
  -- Shared with lifecycle snapshot/publication's exclusive lock. No account data
  -- can cross a snapshot boundary with an old ownership check. Fail fast because
  -- DML already holds a relation lock: waiting would invert snapshot lock order.
  if not pg_try_advisory_xact_lock_shared(723081447301::bigint) then
    raise exception 'Account lifecycle transition in progress; retry transaction' using errcode='40001';
  end if;
  before_row:=case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
  after_row:=case when TG_OP in ('INSERT','UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  before_key:=public.account_recovery_row_key(TG_TABLE_NAME,before_row);
  after_key:=public.account_recovery_row_key(TG_TABLE_NAME,after_row);
  if TG_OP='UPDATE' and pg_trigger_depth()>1 then
    -- Permit only the database's exact SET NULL FK edit while its captured
    -- parent is being purged. Arbitrary trigger-initiated writes stay frozen.
    for cascade_fk in select * from pg_constraint where conrelid=TG_RELID and contype='f' and confdeltype='n' loop
      select array_agg(attname::text) into null_columns from pg_attribute where attrelid=TG_RELID and attnum=any(cascade_fk.conkey);
      if (before_row-null_columns)=(after_row-null_columns)
        and not exists(select 1 from unnest(null_columns) col where after_row->>col is not null)
        and exists(select 1 from public.account_recovery_records parent join public.account_recovery_holds h on h.record_id=parent.id
          join public.account_recovery_requests request on request.id=h.request_id
          where to_regclass('public.'||quote_ident(parent.table_name))=cascade_fk.confrelid and h.kind='delete' and request.state='archiving'
            and not exists(select 1 from unnest(cascade_fk.conkey,cascade_fk.confkey) keys(child_num,parent_num)
              join pg_attribute child_col on child_col.attrelid=cascade_fk.conrelid and child_col.attnum=keys.child_num
              join pg_attribute parent_col on parent_col.attrelid=cascade_fk.confrelid and parent_col.attnum=keys.parent_num
              where before_row->>child_col.attname is null or before_row->>child_col.attname is distinct from coalesce(parent.payload,parent.row_key)->>parent_col.attname)) then return new;
      end if;
    end loop;
  end if;
  if TG_OP<>'DELETE' and exists(select 1 from public.account_recovery_records r where r.table_name=TG_TABLE_NAME
    and (r.row_key_hash=public.account_recovery_key_hash(before_key) or r.row_key_hash=public.account_recovery_key_hash(after_key)) and ((r.erased and not public.account_recovery_recreatable(TG_TABLE_NAME)) or (r.archived and not r.erased))) then raise exception 'Retained record generation cannot be overwritten'; end if;
  for a in select * from public.account_recovery_requests where state in ('archiving','retained','recovering','purging') loop
    if TG_TABLE_NAME in ('profiles','profile_roles') then
      if coalesce(after_row->>'user_id',after_row->>'id')=a.user_id::text and
        (coalesce((a.plan->>'complete')::boolean,false) or after_row->>'role'=a.portal or (a.portal='manager' and after_row->>'role' in ('manager','owner','pro'))) then
        raise exception 'Account recovery decision required';
      end if;
      continue;
    end if;
    for rule in select value from jsonb_array_elements(a.plan->'rules') where value->>'table'=TG_TABLE_NAME loop
      if coalesce((rule->>'retainFinancial')::boolean,false) then continue; end if;
      if public.account_recovery_matches(before_row,rule,a.user_id,a.email) or public.account_recovery_matches(after_row,rule,a.user_id,a.email) then
        select exists(select 1 from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
          where h.request_id=a.id and h.kind='delete' and r.table_name=TG_TABLE_NAME and r.row_key=before_key) into captured;
        if TG_OP='DELETE' and a.state='archiving' and captured then continue; end if;
        raise exception 'Account recovery decision required';
      end if;
    end loop;
    -- Key-only children have no account columns. Their captured identity still
    -- freezes updates; DELETE is permitted only for the pending manifest purge.
    if exists(select 1 from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
      where h.request_id=a.id and h.kind='delete' and r.table_name=TG_TABLE_NAME and (r.row_key_hash=public.account_recovery_key_hash(before_key) or r.row_key_hash=public.account_recovery_key_hash(after_key)))
      and not (TG_OP='DELETE' and a.state='archiving') then raise exception 'Retained child record cannot be overwritten'; end if;
  end loop;
  if TG_OP<>'DELETE' and exists(
    select 1 from pg_constraint fk join pg_class parent_table on parent_table.oid=fk.confrelid
      join public.account_recovery_records stored on stored.table_name=parent_table.relname
      join public.account_recovery_holds hold on hold.record_id=stored.id
      join public.account_recovery_requests request on request.id=hold.request_id
    where fk.conrelid=TG_RELID and fk.contype='f' and parent_table.relnamespace='public'::regnamespace
      and hold.kind='delete' and request.state in ('archiving','retained','recovering','purging')
      and not exists(select 1 from unnest(fk.conkey,fk.confkey) keys(child_num,parent_num)
        join pg_attribute child_col on child_col.attrelid=fk.conrelid and child_col.attnum=keys.child_num
        join pg_attribute parent_col on parent_col.attrelid=fk.confrelid and parent_col.attnum=keys.parent_num
        where after_row->>child_col.attname is null or after_row->>child_col.attname is distinct from coalesce(stored.payload,stored.row_key)->>parent_col.attname)
  ) then raise exception 'New child of a retained record is not allowed'; end if;
  if TG_OP<>'DELETE' and TG_TABLE_NAME in ('screening_orders','cosigner_submission_records') and exists(
    select 1 from public.account_recovery_records stored join public.account_recovery_holds hold on hold.record_id=stored.id
      join public.account_recovery_requests request on request.id=hold.request_id
    where stored.table_name='manager_application_records' and hold.kind='delete'
      and request.state in ('archiving','retained','recovering','purging')
      and stored.row_key->>'id'=after_row->>case when TG_TABLE_NAME='screening_orders' then 'application_id' else 'signer_app_id' end
  ) then raise exception 'New child of a retained application is not allowed'; end if;
  if TG_OP='DELETE' then return old; else return new; end if;
end $$;

do $$ declare t record; f record; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename not like 'account_recovery_%' and tablename<>'account_deleted_record_identities' loop
    execute format('create trigger account_recovery_write_guard before insert or update or delete on public.%I for each row execute function public.account_recovery_write_guard()',t.tablename);
    execute format('create trigger account_recovery_capture_delete after delete on public.%I for each row execute function public.account_recovery_capture_delete()',t.tablename);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'account_recovery_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Keep the verified recovery identity stable until an explicit terminal decision.
create function public.account_recovery_auth_identity_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if current_setting('proplane.account_recovery_internal',true)='on' then
    if TG_OP='DELETE' then return old; else return new; end if;
  end if;
  if not pg_try_advisory_xact_lock_shared(723081447301::bigint) then
    raise exception 'Account lifecycle transition in progress; retry transaction' using errcode='40001';
  end if;
  if (TG_OP='DELETE' or lower(new.email) is distinct from lower(old.email)) and exists(
    select 1 from public.account_recovery_requests where user_id=old.id and state in ('archiving','retained','recovering','purging')
  ) then raise exception 'Finish the account recovery decision before changing its identity'; end if;
  if TG_OP='DELETE' then return old; else return new; end if;
end $$;
create trigger account_recovery_auth_identity_guard before update of email or delete on auth.users for each row execute function public.account_recovery_auth_identity_guard();
revoke all on function public.account_recovery_auth_identity_guard() from public,anon,authenticated;
grant execute on function public.account_recovery_auth_identity_guard() to service_role;
