-- Legacy approval and new coordination ownership share the existing service boundary.
-- A bid tuple can already be locked before its trigger fires, so this path never waits
-- for the advisory lock in reverse order. Contention aborts the statement for retry.
do $$ begin
 if to_regprocedure('public.lock_vendor_service(text)') is null then raise exception 'vendor service boundary prerequisite missing'; end if;
 if exists(select 1 from public.work_order_bids b join public.vendor_coordination_proposals p on p.work_order_id=b.work_order_id
   where b.status='accepted' and p.status in ('collecting','ready','approved') and p.accepted_bid_id is distinct from b.id) then
   raise exception 'legacy accepted bid overlaps active coordination; reconcile before applying fence';
 end if;
end $$;

create or replace function public.guard_legacy_vendor_bid_coordination()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status is distinct from 'accepted' then return new; end if;
 if tg_op='UPDATE' and old.status='accepted' then return new; end if;
 if current_setting('proplane.vendor_coordination_write',true)='on' then return new; end if;
 if not pg_try_advisory_xact_lock(161500,hashtext(new.work_order_id)) then
   raise exception using errcode='40001',message='service ownership changed; retry approval';
 end if;
 if exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=new.work_order_id
   and p.status in ('collecting','ready','approved')) then
   raise exception using errcode='40001',message='approve the current coordinated visit proposal';
 end if;
 return new;
end $$;
revoke all on function public.guard_legacy_vendor_bid_coordination() from public,anon,authenticated;
drop trigger if exists guard_legacy_vendor_bid_coordination on public.work_order_bids;
create trigger guard_legacy_vendor_bid_coordination before insert or update of status on public.work_order_bids
 for each row execute function public.guard_legacy_vendor_bid_coordination();

create or replace function public.guard_vendor_coordination_legacy_winner()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status not in ('collecting','ready','approved') then return new; end if;
 if current_setting('proplane.vendor_coordination_write',true)='on' then return new; end if;
 if not pg_try_advisory_xact_lock(161500,hashtext(new.work_order_id)) then
   raise exception using errcode='40001',message='service ownership changed; retry coordination';
 end if;
 if exists(select 1 from public.work_order_bids b where b.work_order_id=new.work_order_id and b.status='accepted'
   and not (new.status='approved' and new.accepted_bid_id=b.id)
   and not (tg_op='INSERT' and exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=new.work_order_id
     and p.vendor_directory_id=new.vendor_directory_id and p.visit_type=new.visit_type
     and p.status='approved' and p.accepted_bid_id=b.id))) then
   raise exception using errcode='40001',message='service already has an approved legacy bid';
 end if;
 return new;
end $$;
revoke all on function public.guard_vendor_coordination_legacy_winner() from public,anon,authenticated;
drop trigger if exists guard_vendor_coordination_legacy_winner on public.vendor_coordination_proposals;
create trigger guard_vendor_coordination_legacy_winner before insert or update of work_order_id,status on public.vendor_coordination_proposals
 for each row execute function public.guard_vendor_coordination_legacy_winner();
