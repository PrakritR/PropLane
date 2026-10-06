alter table public.manager_expense_entries add column if not exists source_vendor_invoice_id uuid references public.vendor_invoices(id);

-- One cross-rail claim per invoice. Existing money tables remain authoritative.
alter table public.vendor_invoices add column if not exists scheduled_for date;
alter table public.vendor_invoices add column if not exists payment_claim text;
alter table public.vendor_invoices add column if not exists checkout_session_id text;
alter table public.vendor_invoices add column if not exists manager_entered boolean not null default false;
alter table public.vendor_invoices add column if not exists voided_at timestamptz;
alter table public.vendor_invoices add column if not exists offline_method text;

create or replace function public.claim_vendor_invoice_payment(p_invoice uuid, p_manager uuid, p_rail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.vendor_invoices; w public.portal_work_order_records;
begin
 if p_rail not in ('stripe','balance','offline') then raise exception 'Invalid payment source'; end if;
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.voided_at is not null then raise exception 'Invoice not found'; end if;
 if i.status not in ('approved','scheduled','paid') then raise exception 'Invoice must be approved'; end if;
 if i.payment_claim is not null and i.payment_claim <> p_rail then raise exception 'Payment already started using another source'; end if;
 if i.status='paid' and i.payment_claim is null then raise exception 'Invoice already paid'; end if;
 if i.work_order_id is null then raise exception 'Invoice requires an assigned service'; end if;
 select * into w from public.portal_work_order_records where id=i.work_order_id and manager_user_id=p_manager;
 if not found or (i.status <> 'paid' and w.vendor_user_id is distinct from i.vendor_user_id) then raise exception 'Service is not assigned to this vendor'; end if;
 if i.total_cents <= 0 or i.bill_id is null then raise exception 'Invoice has no approved bill'; end if;
 -- Cross-rail arbitration (the older approve-pay rail) is NOT this table's unique index any more -
 -- 20261004140000 loosened it to (work order, invoice); 20261004160000 restores it under a lock.
 if i.payment_claim is null then
   insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,invoice_id,amount_cents,status)
   values(p_manager,i.vendor_user_id,i.work_order_id,i.id,i.total_cents,'pending');
   update public.vendor_invoices set payment_claim=p_rail, updated_at=now() where id=i.id;
 end if;
 return jsonb_build_object('status',i.status,'totalCents',i.total_cents,'vendorUserId',i.vendor_user_id,'billId',i.bill_id);
end $$;
revoke all on function public.claim_vendor_invoice_payment(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_invoice_payment(uuid,uuid,text) to service_role;

create or replace function public.settle_vendor_invoice_payment(p_invoice uuid,p_manager uuid,p_rail text,p_paid_at timestamptz default now(),p_method text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare i public.vendor_invoices; b public.manager_bills; expense_id uuid;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found or i.payment_claim is distinct from p_rail or i.voided_at is not null then raise exception 'Payment claim mismatch'; end if;
 select * into b from public.manager_bills where id=i.bill_id and manager_user_id=p_manager for update;
 if not found or b.amount_cents <> i.total_cents or b.status='void' then raise exception 'Bill mismatch'; end if;
 expense_id := b.paid_expense_entry_id;
 if expense_id is null then
   insert into public.manager_expense_entries(manager_user_id,property_id,vendor_id,category_code,amount_cents,expense_date,memo,source_work_order_id,source_vendor_invoice_id)
   values(p_manager,b.property_id,b.vendor_id,b.category_code,b.amount_cents,(p_paid_at at time zone 'America/Los_Angeles')::date,'Bill paid — '||b.description,b.work_order_id,i.id) returning id into expense_id;
 end if;
 update public.manager_bills set status='paid',paid_at=coalesce(paid_at,p_paid_at),paid_expense_entry_id=expense_id,updated_at=now() where id=b.id;
 update public.vendor_invoices set status='paid',paid_at=coalesce(paid_at,p_paid_at),paid_from=case when p_rail='offline' then null else p_rail end,offline_method=case when p_rail='offline' then p_method else offline_method end,updated_at=now() where id=i.id;
 update public.vendor_payouts set status='paid',updated_at=now() where invoice_id=i.id;
 return b.id;
end $$;
revoke all on function public.settle_vendor_invoice_payment(uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.settle_vendor_invoice_payment(uuid,uuid,text,timestamptz,text) to service_role;

create or replace function public.manage_outgoing_invoice(p_invoice uuid,p_manager uuid,p_action text,p_date date default null)
returns void language plpgsql security definer set search_path=public as $$
declare i public.vendor_invoices;
begin
 select * into i from public.vendor_invoices where id=p_invoice and manager_user_id=p_manager for update;
 if not found then raise exception 'Invoice not found'; end if;
 if i.payment_claim is not null or i.status='paid' then raise exception 'Payment already started'; end if;
 if p_action='delete' then
   if not i.manager_entered then raise exception 'Vendor bills cannot be deleted'; end if;
   update public.vendor_invoices set voided_at=coalesce(voided_at,now()),updated_at=now() where id=i.id;
   update public.manager_bills set status='void',updated_at=now() where id=i.bill_id and manager_user_id=p_manager;
 elsif p_action='schedule' then
   if i.voided_at is not null or i.status not in ('approved','scheduled') or p_date is null or p_date <= (now() at time zone 'America/Los_Angeles')::date then raise exception 'Choose a future payment date for an approved invoice'; end if;
   update public.vendor_invoices set status='scheduled',scheduled_for=p_date,updated_at=now() where id=i.id;
   update public.manager_bills set status='scheduled',updated_at=now() where id=i.bill_id and manager_user_id=p_manager;
 else raise exception 'Invalid action';
 end if;
end $$;
revoke all on function public.manage_outgoing_invoice(uuid,uuid,text,date) from public,anon,authenticated;
grant execute on function public.manage_outgoing_invoice(uuid,uuid,text,date) to service_role;
