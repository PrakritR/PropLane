alter table public.manager_bank_statements add column source_file_name text, add column source_file_sha256 text, add column import_payload jsonb;
create unique index manager_bank_statement_file_once on public.manager_bank_statements(manager_user_id,bank_account_id,source_file_sha256) where source_file_sha256 is not null;
create function public.import_bank_statement_file(p_owner uuid,p_account uuid,p_date date,p_opening bigint,p_closing bigint,p_lines jsonb,p_sha text,p_name text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare existing public.manager_bank_statements%rowtype; statement_id uuid; line jsonb; total bigint := 0; payload jsonb;
begin
  perform 1 from public.manager_bank_accounts where id=p_account and manager_user_id=p_owner for update;
  if not found then raise exception 'Bank account not found'; end if;
  if p_sha !~ '^[0-9a-f]{64}$' or p_sha is null or p_name is null or length(p_name)>255 or p_date is null or p_opening is null or p_closing is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 1000 then raise exception 'Invalid statement file'; end if;
  payload := jsonb_build_object('date',p_date,'opening',p_opening,'closing',p_closing,'lines',p_lines);
  select * into existing from public.manager_bank_statements where manager_user_id=p_owner and bank_account_id=p_account and source_file_sha256=p_sha;
  if found then
    if existing.import_payload <> payload then raise exception 'This file was imported with different reviewed values'; end if;
    return existing.id;
  end if;
  for line in select value from jsonb_array_elements(p_lines) loop
    if (line->>'lineDate')::date is null or (line->>'lineDate')::date>p_date or length(coalesce(line->>'description','')) not between 1 and 1000 or (line->>'amountCents') is null or (line->>'amountCents')::numeric<>trunc((line->>'amountCents')::numeric) then raise exception 'Invalid statement line'; end if;
    total := total + (line->>'amountCents')::bigint;
  end loop;
  if p_opening+total<>p_closing then raise exception 'Opening balance plus transactions must equal closing balance'; end if;
  insert into public.manager_bank_statements(manager_user_id,bank_account_id,statement_date,opening_balance_cents,closing_balance_cents,source_file_name,source_file_sha256,import_payload)
    values(p_owner,p_account,p_date,p_opening,p_closing,p_name,p_sha,payload) returning id into statement_id;
  insert into public.manager_bank_statement_lines(statement_id,line_date,description,amount_cents,cleared)
    select statement_id,(l->>'lineDate')::date,l->>'description',(l->>'amountCents')::bigint,false from jsonb_array_elements(p_lines) l;
  return statement_id;
end $$;
revoke all on function public.import_bank_statement_file(uuid,uuid,date,bigint,bigint,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.import_bank_statement_file(uuid,uuid,date,bigint,bigint,jsonb,text,text) to service_role;
