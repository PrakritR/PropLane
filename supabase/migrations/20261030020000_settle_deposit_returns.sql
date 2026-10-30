-- Account for a provider refund only after its canonical financial records exist.
-- This transaction never creates a second refund journal.
create function public.settle_security_deposit_return(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.security_deposit_return_attempts%rowtype;
  d public.security_deposit_ledger%rowtype;
  c public.portal_household_charge_records%rowtype;
  pay public.ledger_entries%rowtype; r public.ledger_entries%rowtype;
  e public.platform_source_refund_evidence%rowtype; j public.gl_journal_entries%rowtype;
  withholding_journal uuid; lines jsonb; remaining bigint; previous_returned bigint;
  debit_total numeric; credit_total numeric; bad_lines bigint; bill record; claimed numeric; proposed numeric; recorded_refunds numeric;
begin
  select * into a from public.security_deposit_return_attempts where id=p_attempt for update;
  if not found then raise exception 'Return attempt not found'; end if;
  if a.status='reconciled' then return to_jsonb(a); end if;
  if a.status not in ('pending','unknown','succeeded','reserved') or a.provider_refund_id is null then
    raise exception 'Return requires provider reconciliation';
  end if;
  select * into d from public.security_deposit_ledger where id=a.deposit_id and manager_user_id=a.manager_user_id for update;
  if not found or d.source_charge_id is distinct from a.source_charge_id or d.amount_held_cents is distinct from a.expected_held_cents
     or d.status not in ('held','partially_refunded') then raise exception 'Deposit balance requires reconciliation'; end if;
  select * into c from public.portal_household_charge_records where id=a.source_charge_id and manager_user_id=a.manager_user_id for update;
  if not found or c.property_id is distinct from d.property_id or c.row_data->>'kind' is distinct from 'security_deposit' then
    raise exception 'Deposit charge requires reconciliation';
  end if;
  select * into pay from public.ledger_entries where source_charge_id=a.source_charge_id and entry_type='payment';
  if not found or pay.manager_user_id is distinct from a.manager_user_id or pay.property_id is distinct from d.property_id
     or pay.category_code is distinct from 'security_deposit_liability' or pay.stripe_charge_id is null
     or pay.amount_cents is distinct from d.amount_cents or pay.resident_user_id is distinct from d.resident_user_id then raise exception 'Deposit payment requires reconciliation'; end if;
  select * into e from public.platform_source_refund_evidence where stripe_refund_id=a.provider_refund_id;
  if not found or e.status is distinct from 'succeeded' or e.stripe_charge_id is distinct from pay.stripe_charge_id
     or e.amount_cents is distinct from a.refund_cents then raise exception 'Provider refund requires reconciliation'; end if;
  select * into r from public.ledger_entries where source_charge_id=a.source_charge_id and entry_type='refund' and stripe_refund_id=a.provider_refund_id;
  if not found or r.manager_user_id is distinct from a.manager_user_id or r.property_id is distinct from d.property_id
     or r.category_code is distinct from 'security_deposit_liability' or r.stripe_charge_id is distinct from pay.stripe_charge_id
     or r.amount_cents is distinct from a.refund_cents then raise exception 'Refund ledger requires reconciliation'; end if;
  select * into j from public.gl_journal_entries where manager_user_id=a.manager_user_id and source_type='refund'
    and source_id='refund:'||a.source_charge_id||':'||a.provider_refund_id and is_reversal=false;
  if not found or j.property_id is distinct from d.property_id or r.gl_journal_entry_id is distinct from j.id then
    raise exception 'Refund journal requires reconciliation';
  end if;
  select coalesce(sum(debit_cents),0),coalesce(sum(credit_cents),0),count(*) filter (where
    property_id is distinct from d.property_id or resident_user_id is distinct from pay.resident_user_id or
    not ((account_code='security_deposit_liability' and debit_cents>0 and credit_cents=0) or
         (account_code in ('trust_account_security_deposits','accounts_payable') and debit_cents=0 and credit_cents>0)))
    into debit_total,credit_total,bad_lines from public.gl_journal_lines where journal_entry_id=j.id;
  if debit_total <> a.refund_cents or credit_total <> a.refund_cents or bad_lines <> 0 then
    raise exception 'Refund journal lines require reconciliation';
  end if;
  -- A shared approved bill cannot be allocated twice across residents.
  for bill in select b.* from public.manager_bills b where b.id in
    (select (x->'evidence'->>'billId')::uuid from jsonb_array_elements(a.itemization) x where x->'evidence'->>'billId' is not null)
    order by b.id for update loop
    if bill.manager_user_id is distinct from a.manager_user_id or bill.property_id is distinct from d.property_id
       or bill.status not in ('approved','scheduled','paid') then raise exception 'Supporting bill unavailable'; end if;
    select coalesce(sum((x->>'amountCents')::numeric),0) into claimed from public.security_deposit_ledger sd
      cross join lateral jsonb_array_elements(sd.itemization) x where sd.manager_user_id=a.manager_user_id and x->'evidence'->>'billId'=bill.id::text;
    select coalesce(sum((x->>'amountCents')::numeric),0) into proposed from jsonb_array_elements(a.itemization) x where x->'evidence'->>'billId'=bill.id::text;
    if claimed+proposed>bill.amount_cents then raise exception 'Supporting bill already allocated'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(a.itemization) x where x->'evidence'->>'billId' is not null and not exists
    (select 1 from public.manager_bills b where b.id=(x->'evidence'->>'billId')::uuid and b.manager_user_id=a.manager_user_id)) then
    raise exception 'Supporting bill unavailable';
  end if;
  if coalesce(c.row_data->>'depositReturnedCents','0') !~ '^[0-9]+$' then raise exception 'Deposit mirror requires reconciliation'; end if;
  previous_returned := coalesce((c.row_data->>'depositReturnedCents')::bigint,0);
  select coalesce(sum((x->>'amountCents')::numeric),0) into recorded_refunds
    from jsonb_array_elements(d.itemization) x where x->>'kind'='refund';
  if recorded_refunds <> previous_returned then raise exception 'Deposit mirror requires reconciliation'; end if;
  if previous_returned + a.refund_cents > d.amount_cents then raise exception 'Deposit mirror exceeds original amount'; end if;
  if a.withhold_cents>0 then
    insert into public.gl_journal_entries(manager_user_id,property_id,entry_date,memo,source_type,source_id)
      values(a.manager_user_id,d.property_id,j.entry_date,'Deposit withholding','deposit_refund','deposit-withhold:'||a.id::text)
      returning id into withholding_journal;
    insert into public.gl_journal_lines(journal_entry_id,account_code,debit_cents,credit_cents,property_id,resident_user_id)
      values(withholding_journal,'security_deposit_liability',a.withhold_cents,0,d.property_id,d.resident_user_id),
            (withholding_journal,'other_income',0,a.withhold_cents,d.property_id,d.resident_user_id);
  end if;
  select coalesce(jsonb_agg(x || jsonb_build_object('kind','deduction','date',j.entry_date,'journalId',withholding_journal)), '[]'::jsonb)
    into lines from jsonb_array_elements(a.itemization) x;
  lines := coalesce(d.itemization,'[]'::jsonb) || lines || jsonb_build_array(jsonb_build_object(
    'kind','refund','label','Provider refund','amountCents',a.refund_cents,'date',j.entry_date,'sourceId',a.provider_refund_id,'journalId',j.id));
  remaining := d.amount_held_cents-a.refund_cents-a.withhold_cents;
  update public.security_deposit_ledger set amount_held_cents=remaining,
    status=case when remaining>0 or a.withhold_cents>0 then 'partially_refunded' else 'refunded' end,
    disposition_type=case when a.withhold_cents>0 then 'itemized_partial' else 'full_refund' end,
    disposition_date=j.entry_date, disposition_journal_entry_id=coalesce(withholding_journal,j.id),itemization=lines,updated_at=now() where id=d.id;
  update public.portal_household_charge_records set row_data=jsonb_set(coalesce(row_data,'{}'::jsonb),'{depositReturnedCents}',to_jsonb(previous_returned+a.refund_cents),true),updated_at=now() where id=c.id;
  update public.security_deposit_return_attempts set status='reconciled',updated_at=now() where id=a.id returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.settle_security_deposit_return(uuid) from public, anon, authenticated;
grant execute on function public.settle_security_deposit_return(uuid) to service_role;
