-- Per-column keys let an explicit recovery restore only that person's access;
-- another deleted resident/role's stale-write protection remains in force.
create table public.account_deleted_identity_keys (
  table_name text not null,
  record_id text not null,
  column_name text not null,
  identity_hash text not null,
  primary key(table_name,record_id,column_name,identity_hash)
);
alter table public.account_deleted_identity_keys enable row level security;
revoke all on public.account_deleted_identity_keys from anon,authenticated;
grant all on public.account_deleted_identity_keys to service_role;
insert into public.account_deleted_identity_keys
  select g.table_name,g.record_id,c,h from public.account_deleted_record_identities g,
    unnest(g.id_columns||g.email_columns||array['$row_data']) c,unnest(g.identity_hashes) h on conflict do nothing;

create function public.account_recovery_block_identity_keys(p_table text,p_record text,p_ids text[],p_emails text[],p_hashes text[])
returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.account_deleted_identity_keys
    select p_table,p_record,c,h from unnest(p_ids||p_emails||array['$row_data']) c,unnest(p_hashes) h on conflict do nothing
$$;

create or replace function public.account_guard_deleted_financial_identity()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare r jsonb:=to_jsonb(new); k record; hashes text[];
begin
  if TG_OP='UPDATE' and to_jsonb(old)->>'id' is distinct from r->>'id' and
    exists(select 1 from public.account_deleted_record_identities where table_name=TG_TABLE_NAME and record_id=to_jsonb(old)->>'id') then
    raise exception 'Historical financial record identity cannot be changed';
  end if;
  for k in select column_name,array_agg(identity_hash) hashes from public.account_deleted_identity_keys
    where table_name=TG_TABLE_NAME and record_id=r->>'id' group by column_name loop
    if k.column_name='$row_data' then
      if public.account_json_has_deleted_identity(r->'row_data',k.hashes) then raise exception 'Deleted resident identity cannot be reassigned to historical financial records'; end if;
    elsif public.account_identity_hash(r->>k.column_name)=any(k.hashes) or exists(
      select 1 from auth.users where id::text=r->>k.column_name and public.account_identity_hash(email)=any(k.hashes)
    ) then raise exception 'Deleted resident identity cannot be reassigned to historical financial records'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.account_recovery_block_identity_keys(text,text,text[],text[],text[]) from public,anon,authenticated;
grant execute on function public.account_recovery_block_identity_keys(text,text,text[],text[],text[]) to service_role;

create or replace function public.account_preserve_financial_records(p_table text,p_user text,p_email text,p_ids text[],p_emails text[])
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
        (select array_agg(distinct h) from unnest(account_deleted_record_identities.identity_hashes||excluded.identity_hashes) h),
        id_columns=(select array_agg(distinct h) from unnest(account_deleted_record_identities.id_columns||excluded.id_columns) h),
        email_columns=coalesce((select array_agg(distinct h) from unnest(account_deleted_record_identities.email_columns||excluded.email_columns) h),'{}')
      returning marker_id into marker;
    perform public.account_recovery_block_identity_keys(p_table,r.data->>'id',p_ids,p_emails,hashes);
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
    if p_table in ('vendor_invoices','vendor_payouts') then
      execute format('delete from public.%I where id::text=$1 and manager_user_id is null and vendor_user_id is null',p_table) using r.data->>'id';
    end if;
    count_rows:=count_rows+1;
  end loop;
  return count_rows;
end $$;
