-- A withdrawn offer and its unapproved quote are one lifecycle transition.
alter table public.work_order_vendor_offers add column if not exists declined_source_message_id text;

create or replace function public.vendor_sourcing_has_viable_quote(p_work_order_id text,p_manager_user_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.vendor_coordination_proposals p
 join public.portal_work_order_records w on w.id=p.work_order_id and w.manager_user_id=p.manager_user_id
 where p.work_order_id=p_work_order_id and p.manager_user_id=p_manager_user_id
 and p.status in ('collecting','ready') and not p.manager_takeover
 and nullif(trim(p.scope),'') is not null and p.labor_cents is not null and p.materials_cents is not null
 and p.consultation_fee_cents is not null and p.duration_minutes is not null
 and (w.row_data->>'vendorId'=p.vendor_directory_id or exists(
 select 1 from public.work_order_vendor_offers o where o.work_order_id=p.work_order_id
 and o.manager_user_id=p.manager_user_id and o.vendor_directory_id=p.vendor_directory_id
 and o.status='sent' and (o.expires_at is null or o.expires_at>now()))));
$$;
revoke all on function public.vendor_sourcing_has_viable_quote(text,uuid) from public,anon,authenticated;
grant execute on function public.vendor_sourcing_has_viable_quote(text,uuid) to service_role;

create or replace function public.reopen_vendor_sourcing_without_quote(p_work_order_id text,p_manager_user_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- A terminal quote invalidates the worker's old snapshot, but never a manager pause,
 -- takeover, assignment or already-approved financial commitment.
 update public.vendor_sourcing_jobs j set state='queued',next_run_at=now(),lease_token=null,
 lease_until=null,reason=null,updated_at=now()
 where j.work_order_id=p_work_order_id and j.manager_user_id=p_manager_user_id
 and j.state in ('queued','sourcing','waiting','quote_collected','needs_attention')
 and not public.vendor_sourcing_has_viable_quote(p_work_order_id,p_manager_user_id)
 and exists(select 1 from public.portal_work_order_records w where w.id=p_work_order_id
 and w.manager_user_id=p_manager_user_id and w.row_data->>'bucket'='open'
 and nullif(w.row_data->>'vendorId','') is null and coalesce(w.row_data->>'selfAssigned','false')<>'true')
 and not exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=p_work_order_id
 and p.manager_user_id=p_manager_user_id and (p.manager_takeover or p.status='approved' or p.accepted_bid_id is not null));
end $$;
revoke all on function public.reopen_vendor_sourcing_without_quote(text,uuid) from public,anon,authenticated;
grant execute on function public.reopen_vendor_sourcing_without_quote(text,uuid) to service_role;

create or replace function public.wake_vendor_sourcing_quote() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status in ('declined','cancelled') and old.status not in ('declined','cancelled') then
  -- Manager rejection must not keep recontacting the rejected candidate. A separate
  -- remaining live proposal for this vendor (for example consultation) stays usable.
  if not exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=new.work_order_id
    and p.manager_user_id=new.manager_user_id and p.vendor_directory_id=new.vendor_directory_id
    and p.status in ('collecting','ready','approved')) then
   update public.vendor_sourcing_candidates c set status='declined',reason=coalesce(new.revision_reason,'Quote withdrawn'),updated_at=now()
    from public.vendor_sourcing_jobs j where c.job_id=j.id and j.work_order_id=new.work_order_id
    and c.manager_user_id=new.manager_user_id and c.local_directory_id=new.vendor_directory_id;
  end if;
  perform public.reopen_vendor_sourcing_without_quote(new.work_order_id,new.manager_user_id);
 elsif public.vendor_sourcing_has_viable_quote(new.work_order_id,new.manager_user_id) then
  update public.vendor_sourcing_jobs set state='queued',next_run_at=now(),lease_token=null,lease_until=null
   where work_order_id=new.work_order_id and manager_user_id=new.manager_user_id
   and state in ('queued','waiting','needs_attention');
 elsif old.scope is not null and old.labor_cents is not null and old.materials_cents is not null
   and old.consultation_fee_cents is not null and old.duration_minutes is not null then
  -- Removing a required term from the only exact quote also reopens discovery.
  perform public.reopen_vendor_sourcing_without_quote(new.work_order_id,new.manager_user_id);
 end if;
 return new;
end $$;
revoke all on function public.wake_vendor_sourcing_quote() from public,anon,authenticated;

-- Portal and SMS supply authenticated context, never model-selected actor identities.
create or replace function public.decline_vendor_service_quote(
 p_work_order_id text,p_manager_user_id uuid,p_vendor_directory_id text,p_actor_user_id uuid,
 p_verified_phone_e164 text default null,p_reason text default null,p_source_message_id text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.portal_work_order_records; d public.manager_vendor_records; o public.work_order_vendor_offers;
 source_id text:=nullif(left(trim(p_source_message_id),200),''); reason_text text:=nullif(left(trim(p_reason),500),'');
begin
 select * into w from public.portal_work_order_records where id=p_work_order_id and manager_user_id=p_manager_user_id for update;
 if not found then raise exception 'service unavailable'; end if;
 select * into d from public.manager_vendor_records where id=p_vendor_directory_id;
 if not found then raise exception 'vendor unavailable'; end if;
 if p_actor_user_id is distinct from p_manager_user_id and (d.vendor_user_id is null or p_actor_user_id is distinct from d.vendor_user_id)
 and not exists(select 1 from public.vendor_coordination_phone_bindings b where b.manager_user_id=p_manager_user_id
 and b.vendor_directory_id=p_vendor_directory_id and b.revoked_at is null and b.verified_at is not null and b.phone_e164=p_verified_phone_e164) then
  raise exception 'vendor identity unverified';
 end if;
 if exists(select 1 from public.vendor_coordination_proposals where work_order_id=p_work_order_id
 and manager_user_id=p_manager_user_id and vendor_directory_id=p_vendor_directory_id
 and (status='approved' or accepted_bid_id is not null)) then raise exception 'approved commitment requires manager cancellation'; end if;
 select * into o from public.work_order_vendor_offers where work_order_id=p_work_order_id
 and manager_user_id=p_manager_user_id and vendor_directory_id=p_vendor_directory_id for update;
 if not found then raise exception 'vendor offer unavailable'; end if;
 if o.status='declined' and source_id is not null and o.declined_source_message_id=source_id then return true; end if;
 if o.status<>'sent' then return false; end if;
 update public.work_order_vendor_offers set status='declined',declined_reason=reason_text,declined_at=now(),
 declined_source_message_id=source_id,updated_at=now() where id=o.id;
 update public.vendor_coordination_proposals set status='declined',version=version+1,revision_reason=reason_text,
 source_message_ids=case when source_id is null or source_message_ids ? source_id then source_message_ids else source_message_ids||jsonb_build_array(source_id) end,
 updated_at=now() where work_order_id=p_work_order_id and manager_user_id=p_manager_user_id
 and vendor_directory_id=p_vendor_directory_id and status in ('collecting','ready');
 update public.vendor_sourcing_candidates c set status='declined',reason=reason_text,updated_at=now()
 from public.vendor_sourcing_jobs j where c.job_id=j.id and j.work_order_id=p_work_order_id
 and c.manager_user_id=p_manager_user_id and c.local_directory_id=p_vendor_directory_id;
 perform public.reopen_vendor_sourcing_without_quote(p_work_order_id,p_manager_user_id);
 return true;
end $$;
revoke all on function public.decline_vendor_service_quote(text,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.decline_vendor_service_quote(text,uuid,text,uuid,text,text,text) to service_role;

-- Manual offer withdrawal also removes unapproved quote viability. Assignment
-- and approved commitments remain authoritative in the reopen guard above.
create or replace function public.withdraw_vendor_sourcing_offer() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status='withdrawn' and old.status='sent' then
  update public.vendor_coordination_proposals set status='cancelled',version=version+1,
   revision_reason='Offer withdrawn',updated_at=now()
   where work_order_id=new.work_order_id and manager_user_id=new.manager_user_id
   and vendor_directory_id=new.vendor_directory_id and status in ('collecting','ready')
   and accepted_bid_id is null;
  perform public.reopen_vendor_sourcing_without_quote(new.work_order_id,new.manager_user_id);
 end if;
 return new;
end $$;
revoke all on function public.withdraw_vendor_sourcing_offer() from public,anon,authenticated;
drop trigger if exists withdraw_vendor_sourcing_offer on public.work_order_vendor_offers;
create trigger withdraw_vendor_sourcing_offer after update of status on public.work_order_vendor_offers
 for each row execute function public.withdraw_vendor_sourcing_offer();
