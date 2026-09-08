-- Invoices and payouts remain with whichever business account survives.
-- Both ownership links must be nullable; Auth must not cascade away the other side.
do $$ declare t text; c record; col text; begin
  foreach t in array array['vendor_invoices','vendor_payouts'] loop
    foreach col in array array['manager_user_id','vendor_user_id'] loop
      for c in select conname from pg_constraint where conrelid=to_regclass('public.'||t)
        and contype='f' and confrelid='auth.users'::regclass
        and conkey=array[(select attnum from pg_attribute where attrelid=to_regclass('public.'||t) and attname=col)] loop
        execute format('alter table public.%I drop constraint %I',t,c.conname);
      end loop;
      execute format('alter table public.%I alter column %I drop not null',t,col);
      execute format('alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete set null',t,t||'_'||col||'_fkey',col);
    end loop;
    execute format('create trigger account_guard_deleted_financial_identity before insert or update on public.%I for each row execute function public.account_guard_deleted_financial_identity()',t);
  end loop;
end $$;

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
