-- Resident account deletion does not delete the surviving manager's books.
-- Keep only hashed access keys after detachment, to reject stale browser upserts
-- that would otherwise reattach the same email to historical financial records.
create table public.account_deleted_record_identities (
  table_name text not null,
  record_id text not null,
  identity_hashes text[] not null,
  id_columns text[] not null,
  email_columns text[] not null,
  marker_id uuid not null default gen_random_uuid(),
  primary key (table_name, record_id)
);
alter table public.account_deleted_record_identities enable row level security;
revoke all on public.account_deleted_record_identities from anon, authenticated;
grant all on public.account_deleted_record_identities to service_role;

create function public.account_identity_hash(value text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select encode(sha256(convert_to(lower(value),'UTF8')),'hex')
$$;

create function public.account_detach_resident_json(value jsonb, uid text, mail text, marker text)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare k text; v jsonb; result jsonb := '{}';
begin
  if jsonb_typeof(value)='array' then
    select coalesce(jsonb_agg(public.account_detach_resident_json(e,uid,mail,marker)),'[]') into result from jsonb_array_elements(value) e;
    return result;
  end if;
  if jsonb_typeof(value) is distinct from 'object' then return value; end if;
  for k,v in select * from jsonb_each(value) loop
    if k in ('residentUserId','resident_user_id') and nullif(uid,'') is not null and v #>> '{}' = uid then
      v:=to_jsonb(marker);
    elsif k in ('residentEmail','resident_email') and nullif(mail,'') is not null and lower(v #>> '{}')=lower(mail) then
      v:=to_jsonb('deleted-'||marker||'@deleted.invalid');
    elsif jsonb_typeof(v) in ('array','object') then
      v:=public.account_detach_resident_json(v,uid,mail,marker);
    end if;
    result:=result||jsonb_build_object(k,v);
  end loop;
  return result;
end $$;

create function public.account_json_has_deleted_identity(value jsonb, hashes text[])
returns boolean language plpgsql stable set search_path=pg_catalog,public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(value)='array' then
    return exists(select 1 from jsonb_array_elements(value) e where public.account_json_has_deleted_identity(e,hashes));
  end if;
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  for k,v in select * from jsonb_each(value) loop
    if k in ('residentUserId','resident_user_id','residentEmail','resident_email') and
      public.account_identity_hash(v #>> '{}')=any(hashes) then return true; end if;
    if k in ('residentUserId','resident_user_id') and exists(
      select 1 from auth.users u where u.id::text=v #>> '{}' and public.account_identity_hash(u.email)=any(hashes)
    ) then return true; end if;
    if jsonb_typeof(v) in ('array','object') and public.account_json_has_deleted_identity(v,hashes) then return true; end if;
  end loop;
  return false;
end $$;

create function public.account_preserve_financial_records(p_table text,p_user text,p_email text,p_ids text[],p_emails text[])
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare r record; c text; marker uuid; patch jsonb; count_rows integer:=0; hashes text[];
begin
  -- The ownership rules are supplied only by the service-role manifest runner.
  -- Never expose table/column selection as an authenticated-user RPC.
  if p_table !~ '^[a-z_]+$' or p_table like 'account_%' then raise exception 'Invalid financial table'; end if;
  if nullif(p_user,'') is null and nullif(p_email,'') is null then return 0; end if;
  select array_agg(public.account_identity_hash(v)) into hashes from unnest(array[nullif(p_user,''),nullif(p_email,'')]) v where v is not null;
  for r in execute format('select to_jsonb(t) as data from public.%I t where
    exists(select 1 from unnest($1) c where nullif($3,'''') is not null and to_jsonb(t)->>c=$3)
    or exists(select 1 from unnest($2) c where nullif($4,'''') is not null and lower(to_jsonb(t)->>c)=lower($4))
    or public.account_json_has_deleted_identity(to_jsonb(t)->''row_data'',$5) for update',p_table)
    using p_ids,p_emails,p_user,p_email,hashes loop
    if r.data->>'id' is null then raise exception 'Financial record has no stable id'; end if;
    insert into public.account_deleted_record_identities(table_name,record_id,identity_hashes,id_columns,email_columns)
      values(p_table,r.data->>'id',hashes,p_ids,p_emails)
      on conflict(table_name,record_id) do update set identity_hashes=
        (select array_agg(distinct h) from unnest(account_deleted_record_identities.identity_hashes||excluded.identity_hashes) h)
      returning marker_id into marker;
    patch:='{}';
    foreach c in array p_ids loop
      if nullif(p_user,'') is not null and r.data->>c=p_user then patch:=patch||jsonb_build_object(c,null); end if;
    end loop;
    foreach c in array p_emails loop
      if nullif(p_email,'') is not null and lower(r.data->>c)=lower(p_email) then
        patch:=patch||jsonb_build_object(c,'deleted-'||marker::text||'@deleted.invalid');
      end if;
    end loop;
    if r.data ? 'row_data' then patch:=patch||jsonb_build_object('row_data',public.account_detach_resident_json(r.data->'row_data',p_user,p_email,marker::text)); end if;
    -- Single update: the identity guard must never observe a half-detached row.
    select string_agg(format('%I=(jsonb_populate_record(null::public.%I,$1)).%I',key,p_table,key),',') into c from jsonb_object_keys(patch) key;
    if c is not null then execute format('update public.%I set %s where id::text=$2',p_table,c) using patch,r.data->>'id'; end if;
    count_rows:=count_rows+1;
  end loop;
  return count_rows;
end $$;

create function public.account_guard_deleted_financial_identity() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare guard public.account_deleted_record_identities; r jsonb; c text;
begin
  r:=to_jsonb(new);
  if TG_OP='UPDATE' and to_jsonb(old)->>'id' is distinct from r->>'id' and
    exists(select 1 from public.account_deleted_record_identities where table_name=TG_TABLE_NAME and record_id=to_jsonb(old)->>'id') then
    raise exception 'Historical financial record identity cannot be changed';
  end if;
  select * into guard from public.account_deleted_record_identities where table_name=TG_TABLE_NAME and record_id=r->>'id';
  if not found then return new; end if;
  foreach c in array guard.id_columns||guard.email_columns loop
    if public.account_identity_hash(r->>c)=any(guard.identity_hashes) then raise exception 'Deleted resident identity cannot be reassigned to historical financial records'; end if;
  end loop;
  foreach c in array guard.id_columns loop
    if exists(select 1 from auth.users u where u.id::text=r->>c and public.account_identity_hash(u.email)=any(guard.identity_hashes)) then
      raise exception 'Deleted resident identity cannot be reassigned to historical financial records';
    end if;
  end loop;
  if public.account_json_has_deleted_identity(r->'row_data',guard.identity_hashes) then raise exception 'Deleted resident identity cannot be reassigned to historical financial records'; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['ledger_entries','security_deposit_ledger','manager_payment_plans','portal_household_charge_records','portal_lease_pipeline_records'] loop
    execute format('create trigger account_guard_deleted_financial_identity before insert or update on public.%I for each row execute function public.account_guard_deleted_financial_identity()',t);
  end loop;
end $$;

-- The existing manifest already detaches surviving audit actors; make the schema agree.
alter table public.audit_log alter column actor_user_id drop not null;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('account_identity_hash','account_detach_resident_json','account_json_has_deleted_identity','account_preserve_financial_records','account_guard_deleted_financial_identity') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
