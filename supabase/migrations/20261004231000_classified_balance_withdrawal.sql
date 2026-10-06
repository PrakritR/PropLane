-- A withdrawal claim is a source-bound balance debit before any Stripe call.
-- An unstamped debit is deliberately durable: an ambiguous provider result
-- may only be reconciled by its exact frozen key and destination.
alter table public.proplane_balance_entries
  add column if not exists withdrawal_destination_account_id text,
  add column if not exists withdrawal_payout_id text,
  add column if not exists withdrawal_provider_status text;
alter table public.proplane_balance_entries drop constraint if exists proplane_classified_withdrawal_terms;
alter table public.proplane_balance_entries add constraint proplane_classified_withdrawal_terms check
  (withdrawal_destination_account_id is null or
   (kind='withdrawal' and nullif(trim(withdrawal_destination_account_id),'') is not null and
    source_spend_breakdown is not null and jsonb_typeof(source_spend_breakdown)='array'));
-- One provider transfer can settle several captured source components. Keep
-- its real id on every leg rather than manufacturing per-leg provider ids.
alter table public.platform_source_consumption_legs
  drop constraint if exists platform_source_consumption_legs_provider_transfer_id_key;
create index if not exists platform_source_withdrawal_transfer_idx
  on public.platform_source_consumption_legs(provider_transfer_id)
  where provider_transfer_id is not null;

-- Older balance callers insert an unclassified debit directly (withdrawal)
-- or through proplane_balance_move. Once a classified mirror exists, that
-- aggregate path cannot prove which captured source it spent. Serialize with
-- classified credit/reservation on the account row and reject the insert.
-- Historical completed rows and exact move replays do not insert a new debit.
create or replace function public.reject_legacy_classified_balance_debit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.amount_cents<0 and new.source_spend_breakdown is null then
    perform 1 from public.proplane_balance_accounts where id=new.account_id for update;
    if exists(select 1 from public.proplane_balance_entries
      where account_id=new.account_id and source_hold_id is not null and
        kind='resident_payment') or
       exists(select 1 from public.proplane_balance_entries credit
         join public.platform_source_consumption_legs leg
           on leg.wallet_credit_entry_id=credit.id and leg.kind='vendor_payment'
         where credit.account_id=new.account_id and credit.kind='vendor_payment_in') then
      raise exception 'legacy balance debit cannot spend classified source';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists reject_legacy_classified_balance_debit on public.proplane_balance_entries;
create trigger reject_legacy_classified_balance_debit before insert
  on public.proplane_balance_entries for each row
  execute function public.reject_legacy_classified_balance_debit();

create or replace function public.reserve_platform_classified_withdrawal(
  p_account uuid,p_owner uuid,p_kind text,p_amount bigint,p_key text,p_destination text,p_parts jsonb
) returns public.proplane_balance_entries
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_account public.proplane_balance_accounts; v_existing public.proplane_balance_entries;
  v_hold public.platform_payment_holds; v_mirror public.proplane_balance_entries;
  v_credit public.proplane_balance_entries; v_parent public.proplane_balance_entries;
  v_part jsonb; v_component jsonb; v_source text; v_take integer;
  v_captured integer; v_refunded integer; v_consumed integer;
  v_transferred integer; v_reversed integer; v_reserved integer;
  v_sum bigint:=0; v_available bigint; v_income bigint:=0;
  v_charge text; v_pi text; v_hold_id uuid; v_credit_id uuid;
begin
  if p_account is null or p_owner is null or p_kind not in ('workspace','vendor') or
     p_amount is null or p_amount<=0 or p_amount>2147483647 or
     nullif(trim(p_key),'') is null or nullif(trim(p_destination),'') is null or
     jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts)=0 then
    raise exception 'classified withdrawal terms are incomplete';
  end if;
  if p_kind='workspace' then
    perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||p_owner::text,0));
  end if;
  select * into v_account from public.proplane_balance_accounts where id=p_account;
  if not found or v_account.owner_kind is distinct from p_kind or
     v_account.owner_key is distinct from p_owner::text or v_account.currency<>'usd' then
    raise exception 'classified withdrawal account owner mismatch';
  end if;
  select * into v_existing from public.proplane_balance_entries
    where account_id=p_account and idempotency_key=p_key;
  if found then
    if v_existing.kind<>'withdrawal' or v_existing.amount_cents is distinct from -p_amount or
       v_existing.status<>'available' or v_existing.source_spend_breakdown is distinct from p_parts or
       v_existing.withdrawal_destination_account_id is distinct from p_destination then
      raise exception 'classified withdrawal replay changed immutable terms';
    end if;
    return v_existing;
  end if;
  if p_kind='workspace' then
    if exists(select 1 from jsonb_array_elements(p_parts) as part(value)
      where jsonb_typeof(value)<>'object' or nullif(value->>'source_id','') is null or
        (value->>'hold_id') is null or
        (value->>'source_net_cents') is null or
        (value->>'source_net_cents')::integer<=0) or
       (select count(*) from jsonb_array_elements(p_parts)) is distinct from
       (select count(distinct (value->>'hold_id',value->>'source_id'))
          from jsonb_array_elements(p_parts) as value) then
      raise exception 'classified withdrawal component vector is invalid';
    end if;
    -- Respect the owner -> charge -> PI -> hold -> wallet order shared with
    -- release, refund, recovery, and the classified internal mover.
    for v_charge in select distinct h.stripe_charge_id
        from jsonb_array_elements(p_parts) as part(value)
        join public.platform_payment_holds h on h.id=(value->>'hold_id')::uuid
        order by h.stripe_charge_id loop
      if nullif(trim(v_charge),'') is null then raise exception 'classified withdrawal source charge needs review'; end if;
      perform pg_advisory_xact_lock(hashtextextended('platform-source-charge:'||v_charge,0));
    end loop;
    for v_pi in select distinct h.source_payment_intent_id
        from jsonb_array_elements(p_parts) as part(value)
        join public.platform_payment_holds h on h.id=(value->>'hold_id')::uuid
        order by h.source_payment_intent_id loop
      if nullif(trim(v_pi),'') is null then raise exception 'classified withdrawal source PI needs review'; end if;
      perform pg_advisory_xact_lock(hashtextextended('platform-hold-pi:'||v_pi,0));
    end loop;
    for v_hold in select h.* from public.platform_payment_holds h
        where h.id in (select (value->>'hold_id')::uuid from jsonb_array_elements(p_parts) as value)
        order by h.id for update loop
      if v_hold.owner_user_id is distinct from p_owner or v_hold.owner_role<>'manager' or
         v_hold.status<>'classified_held' or v_hold.source_verified_at is null or
         v_hold.source_allocation_mode<>'hold' or
         public.platform_source_has_unmapped_refund(v_hold.stripe_charge_id) or
         exists(select 1 from public.platform_hold_refund_attempts r
           where r.hold_id=v_hold.id and (r.status='reserved' or
             (r.status='succeeded' and r.recipient_debit_components is null))) or
         exists(select 1 from public.platform_hold_transfer_attempts t
           where t.hold_id=v_hold.id and t.status='reserved') or
         exists(select 1 from public.platform_source_consumption_legs l
           where l.hold_id=v_hold.id and l.status='reserved' and l.kind<>'owner_debt_recovery') then
        raise exception 'classified withdrawal source is unavailable';
      end if;
      select coalesce(sum((c.value->>'recipient_net_cents')::integer),0)::integer
        - (select coalesce(sum((d.value->>'recipient_debit_cents')::integer),0)::integer
           from public.platform_hold_refund_attempts r,
             lateral jsonb_array_elements(r.recipient_debit_components) as d(value)
           where r.hold_id=v_hold.id and r.status='succeeded')
        - (select coalesce(sum(l.source_net_cents),0)::integer
           from public.platform_source_consumption_legs l
           where l.hold_id=v_hold.id and l.status='settled')
        into v_captured from jsonb_array_elements(v_hold.source_components) as c(value);
      if v_captured is distinct from v_hold.amount_cents then
        raise exception 'classified withdrawal hold remainder differs from captured components';
      end if;
    end loop;
    if (select count(distinct (value->>'hold_id')::uuid) from jsonb_array_elements(p_parts) as value)
       is distinct from (select count(*) from public.platform_payment_holds h
         where h.id in (select (value->>'hold_id')::uuid from jsonb_array_elements(p_parts) as value)) then
      raise exception 'classified withdrawal source hold is missing';
    end if;
  else
    if exists(select 1 from jsonb_array_elements(p_parts) as part(value)
      where jsonb_typeof(value)<>'object' or (value->>'vendor_credit_entry_id') is null or
        (value->>'source_net_cents') is null or
        (value->>'source_net_cents')::integer<=0) or
       (select count(*) from jsonb_array_elements(p_parts)) is distinct from
       (select count(distinct (value->>'vendor_credit_entry_id'))
          from jsonb_array_elements(p_parts) as value) then
      raise exception 'classified vendor withdrawal vector is invalid';
    end if;
  end if;
  select * into v_account from public.proplane_balance_accounts where id=p_account for update;
  if v_account.owner_kind is distinct from p_kind or v_account.owner_key is distinct from p_owner::text then
    raise exception 'classified withdrawal account changed';
  end if;
  for v_part in select value from jsonb_array_elements(p_parts) as value loop
    v_take:=(v_part->>'source_net_cents')::integer;
    v_sum:=v_sum+v_take;
    if p_kind='workspace' then
      v_hold_id:=(v_part->>'hold_id')::uuid; v_source:=v_part->>'source_id';
      select * into v_hold from public.platform_payment_holds where id=v_hold_id;
      select value into v_component from jsonb_array_elements(v_hold.source_components) as value
        where value->>'source_id'=v_source;
      if not found or v_component->>'liability_class' not in ('income','deposit') then
        raise exception 'classified withdrawal component is not owned money';
      end if;
      select * into v_mirror from public.proplane_balance_entries
        where source_hold_id=v_hold_id and source_component_id=v_source for update;
      if not found or v_mirror.account_id is distinct from p_account or
         v_mirror.kind<>'resident_payment' or v_mirror.status<>'available' or
         v_mirror.available_on is null or v_mirror.available_on>now() or
         v_mirror.stripe_object_id is distinct from v_hold.stripe_charge_id or
         v_mirror.amount_cents is distinct from (v_component->>'recipient_net_cents')::integer or
         v_mirror.source_liability_class is distinct from v_component->>'liability_class' then
        raise exception 'classified withdrawal mirror is not cleared';
      end if;
      select coalesce(sum((d.value->>'recipient_debit_cents')::integer),0)::integer into v_refunded
        from public.platform_hold_refund_attempts r,
          lateral jsonb_array_elements(r.recipient_debit_components) as d(value)
        where r.hold_id=v_hold_id and r.status='succeeded' and d.value->>'source_id'=v_source;
      select coalesce(sum(l.source_net_cents),0)::integer into v_consumed
        from public.platform_source_consumption_legs l
        where l.hold_id=v_hold_id and l.source_component_id=v_source and l.status='settled';
      select coalesce(sum((c.value->>'recipient_net_cents')::integer),0)::integer into v_transferred
        from public.platform_hold_transfer_attempts t,
          lateral jsonb_array_elements(t.component_breakdown) as c(value)
        where t.hold_id=v_hold_id and t.status='created' and c.value->>'source_id'=v_source;
      select coalesce(sum((c.value->>'recipient_net_cents')::integer),0)::integer into v_reversed
        from public.platform_hold_refund_transfer_legs l,
          lateral jsonb_array_elements(l.component_breakdown) as c(value)
        where l.hold_id=v_hold_id and l.status='created' and c.value->>'source_id'=v_source;
      select coalesce(sum(l.source_net_cents),0)::integer into v_reserved
        from public.platform_source_consumption_legs l
        where l.hold_id=v_hold_id and l.source_component_id=v_source and l.status='reserved';
      if v_transferred<v_reversed or
         (v_component->>'recipient_net_cents')::integer-v_refunded-v_consumed-v_transferred+v_reversed-v_reserved<v_take then
        raise exception 'classified withdrawal component is already consumed or reserved';
      end if;
      if v_component->>'liability_class'='income' then v_income:=v_income+v_take; end if;
    else
      v_credit_id:=(v_part->>'vendor_credit_entry_id')::uuid;
      select * into v_credit from public.proplane_balance_entries where id=v_credit_id for update;
      select * into v_parent from public.proplane_balance_entries where id=v_credit.related_entry_id;
      if v_credit.id is null or v_credit.account_id is distinct from p_account or
         v_credit.kind<>'vendor_payment_in' or v_credit.status<>'available' or
         v_credit.related_entry_id is null or v_parent.id is null or
         v_parent.kind<>'vendor_payment_out' or v_parent.related_entry_id is distinct from v_credit.id or
         v_parent.source_income_debit_cents is distinct from v_credit.amount_cents or
         jsonb_typeof(v_parent.source_spend_breakdown)<>'array' or
         (select count(*) from public.platform_source_consumption_legs l
           where l.wallet_debit_entry_id=v_parent.id and l.wallet_credit_entry_id=v_credit.id and
             l.status='settled' and l.beneficiary_user_id=p_owner and l.kind='vendor_payment')
           is distinct from jsonb_array_length(v_parent.source_spend_breakdown) or
         v_credit.amount_cents - (select coalesce(sum((part.value->>'source_net_cents')::integer),0)
           from public.proplane_balance_entries w,
             lateral jsonb_array_elements(w.source_spend_breakdown) as part(value)
           where w.account_id=p_account and w.kind='withdrawal' and
             w.withdrawal_destination_account_id is not null and
             (w.stripe_object_id is null or w.stripe_object_id not like 'reversed:%') and
             part.value->>'vendor_credit_entry_id'=v_credit.id::text) < v_take then
        raise exception 'classified vendor earnings are unavailable';
      end if;
    end if;
  end loop;
  if v_sum is distinct from p_amount then raise exception 'classified withdrawal amount differs from source vector'; end if;
  -- Unknown positive accounting adjustments and old aggregate credits can
  -- never fund a new withdrawal. Every negative entry reduces cash capacity.
  if p_kind='workspace' then
    select coalesce(sum(case when amount_cents>0 and kind='resident_payment' and
      source_hold_id is not null and source_liability_class in ('income','deposit')
      then amount_cents when amount_cents<0 then amount_cents else 0 end),0)
      into v_available from public.proplane_balance_entries
      where account_id=p_account and status='available';
  else
    select coalesce(sum(case when amount_cents>0 and kind='vendor_payment_in' and
      related_entry_id is not null then amount_cents
      when amount_cents<0 then amount_cents else 0 end),0)
      into v_available from public.proplane_balance_entries
      where account_id=p_account and status='available';
  end if;
  if v_available<p_amount then
    raise exception 'INSUFFICIENT_BALANCE: available=% requested=%',v_available,p_amount;
  end if;
  insert into public.proplane_balance_entries
    (account_id,amount_cents,kind,status,available_on,idempotency_key,
      source_spend_breakdown,source_income_debit_cents,withdrawal_destination_account_id,
      withdrawal_provider_status)
    values(p_account,-p_amount,'withdrawal','available',now(),p_key,p_parts,v_income,
      p_destination,'reserved') returning * into v_existing;
  if p_kind='workspace' then
    for v_part in select value from jsonb_array_elements(p_parts) as value loop
      insert into public.platform_source_consumption_legs
        (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
          wallet_debit_entry_id,attempt_key,status)
        values((v_part->>'hold_id')::uuid,v_part->>'source_id',p_owner,'owner_withdrawal',
          (v_part->>'source_net_cents')::integer,v_existing.id,
          p_key||':source:'||(v_part->>'hold_id')||':'||(v_part->>'source_id'),'reserved');
    end loop;
  end if;
  return v_existing;
end $$;

create or replace function public.finish_platform_classified_withdrawal(
  p_entry uuid,p_key text,p_destination text,p_transfer text
) returns public.proplane_balance_entries
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_entry public.proplane_balance_entries; v_account public.proplane_balance_accounts;
  v_part jsonb; v_hold public.platform_payment_holds; v_count integer;
begin
  select * into v_entry from public.proplane_balance_entries where id=p_entry;
  if not found or v_entry.kind<>'withdrawal' or v_entry.idempotency_key is distinct from p_key or
     v_entry.withdrawal_destination_account_id is distinct from p_destination or
     nullif(trim(p_transfer),'') is null then raise exception 'withdrawal transfer claim mismatch'; end if;
  select * into v_account from public.proplane_balance_accounts where id=v_entry.account_id;
  if v_account.owner_kind='workspace' then
    perform pg_advisory_xact_lock(hashtextextended('platform-owner-recovery:'||v_account.owner_key,0));
    for v_hold in select h.* from public.platform_payment_holds h
        where h.id in (select (value->>'hold_id')::uuid
          from jsonb_array_elements(v_entry.source_spend_breakdown) as value)
        order by h.id for update loop perform 1; end loop;
  end if;
  select * into v_entry from public.proplane_balance_entries where id=p_entry for update;
  if v_entry.stripe_object_id is not null then
    if v_entry.stripe_object_id is distinct from p_transfer or
       v_entry.withdrawal_provider_status not in ('created','payout_created') then
      raise exception 'withdrawal transfer changed on replay'; end if;
    return v_entry;
  end if;
  if v_entry.withdrawal_provider_status not in ('reserved','unknown') then
    raise exception 'withdrawal transfer is not reserved'; end if;
  if v_account.owner_kind='workspace' then
    select count(*)::integer into v_count from public.platform_source_consumption_legs
      where wallet_debit_entry_id=p_entry and kind='owner_withdrawal' and status='reserved';
    if v_count is distinct from jsonb_array_length(v_entry.source_spend_breakdown) then
      raise exception 'withdrawal source reservation changed'; end if;
    for v_part in select value from jsonb_array_elements(v_entry.source_spend_breakdown) as value loop
      update public.platform_source_consumption_legs set status='settled',
        provider_transfer_id=p_transfer,updated_at=now()
        where wallet_debit_entry_id=p_entry and hold_id=(v_part->>'hold_id')::uuid and
          source_component_id=v_part->>'source_id' and kind='owner_withdrawal' and
          source_net_cents=(v_part->>'source_net_cents')::integer and status='reserved';
      if not found then raise exception 'withdrawal source reservation changed'; end if;
      update public.platform_payment_holds set amount_cents=amount_cents-(v_part->>'source_net_cents')::integer,
        updated_at=now() where id=(v_part->>'hold_id')::uuid and status='classified_held' and
          amount_cents>=(v_part->>'source_net_cents')::integer;
      if not found then raise exception 'withdrawal held remainder changed'; end if;
    end loop;
  end if;
  update public.proplane_balance_entries set stripe_object_id=p_transfer,
    withdrawal_provider_status='created' where id=p_entry returning * into v_entry;
  return v_entry;
end $$;

revoke all on function public.reserve_platform_classified_withdrawal(uuid,uuid,text,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finish_platform_classified_withdrawal(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.reserve_platform_classified_withdrawal(uuid,uuid,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.finish_platform_classified_withdrawal(uuid,text,text,text) to service_role;
