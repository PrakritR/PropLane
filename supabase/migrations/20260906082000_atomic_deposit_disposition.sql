-- Every disposition entry point uses this transaction, so an import cannot post
-- journals against a balance concurrently disposed through the normal portal.
create or replace function public.commit_security_deposit_disposition(
  p_owner uuid, p_deposit uuid, p_expected_held bigint,
  p_refund bigint, p_withhold bigint, p_type text, p_date date,
  p_itemization jsonb, p_memo text, p_history jsonb default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d public.security_deposit_ledger%rowtype;
  events jsonb; e jsonb; j uuid; last_j uuid;
  refund bigint; withheld bigint; event_total bigint; total bigint := 0;
  remaining bigint; source text; event_date date; next_status text;
begin
  select * into d from public.security_deposit_ledger where id=p_deposit and manager_user_id=p_owner for update;
  if not found then raise exception 'Deposit not found'; end if;
  if p_refund < 0 or p_withhold < 0 or p_refund is null or p_withhold is null or p_refund+p_withhold <= 0
    or p_type not in ('full_refund','itemized_partial','full_withhold') or p_type is null
    or p_date is null or jsonb_typeof(p_itemization) is distinct from 'array' then raise exception 'Invalid disposition'; end if;
  remaining := p_expected_held - p_refund - p_withhold;
  if remaining < 0 then raise exception 'Disposition exceeds held amount'; end if;
  if p_history is not null and d.amount_held_cents=remaining and d.itemization=p_itemization then return to_jsonb(d); end if;
  if d.amount_held_cents <> p_expected_held or d.status not in ('held','partially_refunded') then raise exception 'Deposit balance changed; review again'; end if;
  if p_history is not null then
    if d.status <> 'held' or d.amount_cents <> p_expected_held or jsonb_typeof(p_history) <> 'array' or jsonb_array_length(p_history)=0 or d.itemization <> '[]'::jsonb then raise exception 'History requires an untouched original deposit'; end if;
    events := p_history;
  else
    events := jsonb_build_array(jsonb_build_object('refund',p_refund,'withhold',p_withhold,'date',p_date,'sourceId','deposit-dispose:'||d.id||':'||p_date||':'||p_expected_held,'label',p_memo));
  end if;
  for e in select value from jsonb_array_elements(events) loop
    if p_history is not null then
      if e->>'kind' not in ('refund','deduction') or (e->>'amountCents')::numeric <> trunc((e->>'amountCents')::numeric) or (e->>'amountCents')::bigint <= 0 then raise exception 'Invalid history event'; end if;
      refund := case when e->>'kind'='refund' then (e->>'amountCents')::bigint else 0 end;
      withheld := case when e->>'kind'='deduction' then (e->>'amountCents')::bigint else 0 end;
    else
      refund := (e->>'refund')::bigint; withheld := (e->>'withhold')::bigint;
    end if;
    event_total := refund+withheld;
    event_date := (e->>'date')::date;
    source := 'deposit:'||d.id||':'||(e->>'sourceId');
    if event_date is null or event_date < d.received_date or source is null then raise exception 'Invalid event provenance'; end if;
    total := total + event_total;
    insert into public.gl_journal_entries(manager_user_id,property_id,entry_date,memo,source_type,source_id)
      values(p_owner,d.property_id,event_date,e->>'label','deposit_refund',source) returning id into j;
    insert into public.gl_journal_lines(journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(j,'security_deposit_liability',event_total,0,d.property_id,d.resident_user_id);
    if refund>0 then insert into public.gl_journal_lines(journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(j,'trust_account_security_deposits',0,refund,d.property_id,d.resident_user_id); end if;
    if withheld>0 then insert into public.gl_journal_lines(journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(j,'other_income',0,withheld,d.property_id,d.resident_user_id); end if;
    last_j := j;
  end loop;
  if total <> p_refund+p_withhold then raise exception 'History does not reconcile'; end if;
  next_status := case when remaining>0 or (p_refund>0 and p_withhold>0) then 'partially_refunded' when p_withhold>0 and p_type='full_withhold' then 'forfeited' when p_withhold>0 then 'applied_to_damages' else 'refunded' end;
  update public.security_deposit_ledger set amount_held_cents=remaining,status=next_status,
    disposition_type=p_type,disposition_date=p_date,itemization=p_itemization,
    disposition_journal_entry_id=last_j,updated_at=now()
    where id=d.id and manager_user_id=p_owner returning * into d;
  return to_jsonb(d);
end $$;
revoke all on function public.commit_security_deposit_disposition(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.commit_security_deposit_disposition(uuid,uuid,bigint,bigint,bigint,text,date,jsonb,text,jsonb) to service_role;
