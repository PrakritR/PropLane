-- Scan reference data inside PostgreSQL instead of exporting every tenant's messages.
-- Shared support threads and other surviving records retain their attachment bytes.
create function public.account_referenced_attachment_paths(p_candidates jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c jsonb; col record; referenced boolean; retained jsonb:='[]';
begin
  if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>100 then
    raise exception 'Invalid attachment batch';
  end if;
  for c in select value from jsonb_array_elements(p_candidates) loop
    if nullif(c->>'path','') is null or nullif(c->>'encoded','') is null then raise exception 'Invalid attachment path'; end if;
    referenced:=false;
    for col in select table_name,column_name from information_schema.columns
      where table_schema='public' and data_type in ('json','jsonb')
        and table_name not like 'account_recovery_%' and table_name <> 'account_deleted_record_identities' loop
      execute format('select exists(select 1 from public.%I where strpos(%I::text,$1)>0 or strpos(%I::text,$2)>0)',col.table_name,col.column_name,col.column_name)
        into referenced using c->>'path',c->>'encoded';
      exit when referenced;
    end loop;
    if referenced then retained:=retained||jsonb_build_array(c->>'path'); end if;
  end loop;
  return retained;
end $$;
revoke all on function public.account_referenced_attachment_paths(jsonb) from public,anon,authenticated;
grant execute on function public.account_referenced_attachment_paths(jsonb) to service_role;
