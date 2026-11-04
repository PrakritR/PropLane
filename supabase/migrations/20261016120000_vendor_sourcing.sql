-- Directory contacts remain directory identities, never synthetic auth accounts.
alter table public.agent_sessions alter column user_id drop not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agent_sessions_directory_identity_check') then
  alter table public.agent_sessions add constraint agent_sessions_directory_identity_check check(user_id is not null or (kind='vendor_work_order' and vendor_directory_id is not null));
 end if;
end $$;
-- Quote gathering only. Booking and all money remain vendor_coordination_action approvals.
create table if not exists public.vendor_sourcing_jobs (
 id uuid primary key default gen_random_uuid(),
 work_order_id text not null unique references public.portal_work_order_records(id) on delete cascade,
 manager_user_id uuid not null references auth.users(id) on delete cascade,
 state text not null default 'dormant' check(state in ('dormant','queued','sourcing','waiting','quote_collected','needs_attention','paused','complete')),
 stage integer not null default 0 check(stage between 0 and 2),
 next_run_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 attempts integer not null default 0, reason text, notified_state text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.vendor_sourcing_candidates (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.vendor_sourcing_jobs(id) on delete cascade,
 manager_user_id uuid not null references auth.users(id) on delete cascade,
 stage integer not null check(stage between 0 and 2), source text not null check(source in ('roster','shared','web')),
 dedupe_key text not null, contact jsonb not null, source_directory_id text,
 local_directory_id text, proposal_id uuid references public.vendor_coordination_proposals(id) on delete set null,
 status text not null default 'discovered', reason text, outbox_id uuid,
 expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(job_id,dedupe_key)
);
create index if not exists vendor_sourcing_due on public.vendor_sourcing_jobs(next_run_at) where state in ('queued','sourcing','waiting');
alter table public.vendor_sourcing_jobs enable row level security;
alter table public.vendor_sourcing_candidates enable row level security;
revoke all on public.vendor_sourcing_jobs,public.vendor_sourcing_candidates from public,anon,authenticated;
grant all on public.vendor_sourcing_jobs,public.vendor_sourcing_candidates to service_role;
create or replace function public.enqueue_vendor_sourcing() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.manager_user_id is not null and nullif(new.resident_email,'') is not null and coalesce(new.row_data->>'managerInitiated','false') <> 'true' then
  insert into public.vendor_sourcing_jobs(work_order_id,manager_user_id,state)
   values(new.id,new.manager_user_id,case when exists(select 1 from public.manager_automation_settings s where s.manager_user_id=new.manager_user_id and s.vendor_dispatch->>'quoteSourcingEnabled'='true') then 'queued' else 'dormant' end)
   on conflict(work_order_id) do nothing;
 end if; return new;
end $$;
revoke all on function public.enqueue_vendor_sourcing() from public,anon,authenticated;
drop trigger if exists enqueue_vendor_sourcing on public.portal_work_order_records;
create trigger enqueue_vendor_sourcing after insert on public.portal_work_order_records for each row execute function public.enqueue_vendor_sourcing();
create or replace function public.claim_vendor_sourcing(p_limit integer default 3,p_work_order_id text default null)
returns setof public.vendor_sourcing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
 return query with due as (
 select id from public.vendor_sourcing_jobs where state in ('queued','sourcing','waiting') and next_run_at<=now()
 and (lease_until is null or lease_until<now()) and (p_work_order_id is null or work_order_id=p_work_order_id)
 order by next_run_at for update skip locked limit least(greatest(p_limit,1),3))
 update public.vendor_sourcing_jobs j set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=j.attempts+1,updated_at=now()
 from due where j.id=due.id returning j.*;
end $$;
revoke all on function public.claim_vendor_sourcing(integer,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_sourcing(integer,text) to service_role;
-- All materialization, eligibility and enrollment share the service/job lock.
create or replace function public.enroll_vendor_sourcing_candidate(p_candidate_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_sourcing_candidates; j public.vendor_sourcing_jobs; w public.portal_work_order_records;
 d public.manager_vendor_records; local_id text; proposal jsonb; expiry timestamptz;
begin
 select * into c from public.vendor_sourcing_candidates where id=p_candidate_id;
 select * into j from public.vendor_sourcing_jobs where id=c.job_id for update;
 if not found or j.lease_token is distinct from p_lease_token or j.lease_until<now() or j.state not in ('queued','sourcing','waiting') then raise exception 'sourcing lease lost'; end if;
 select * into w from public.portal_work_order_records where id=j.work_order_id for update;
 if w.manager_user_id is distinct from j.manager_user_id or w.row_data->>'bucket'<>'open' or nullif(w.row_data->>'vendorId','') is not null or w.row_data->>'selfAssigned'='true' then raise exception 'sourcing service stopped'; end if;
 if c.manager_user_id<>j.manager_user_id then raise exception 'sourcing owner mismatch'; end if;
 if exists(select 1 from public.vendor_coordination_proposals where work_order_id=w.id and (manager_takeover or status='approved')) then raise exception 'sourcing taken over'; end if;
 if c.source in ('roster','shared') then
  select * into d from public.manager_vendor_records where id=c.source_directory_id;
  if not found or (c.source='roster' and d.manager_user_id is distinct from j.manager_user_id) or d.row_data->>'active'='false' or (d.manager_user_id is distinct from j.manager_user_id and coalesce(d.row_data->>'sharedWithManagers','false')<>'true') then raise exception 'vendor no longer shared or active'; end if;
 end if;
 local_id := case when c.source='roster' then d.id else 'sourced-'||md5(j.manager_user_id::text||':'||c.dedupe_key) end;
 if c.source<>'roster' then
  insert into public.manager_vendor_records(id,manager_user_id,vendor_user_id,row_data)
   values(local_id,j.manager_user_id,case when c.source='shared' then d.vendor_user_id else null end,
    jsonb_build_object('id',local_id,'managerUserId',j.manager_user_id,'name',c.contact->>'name','trade',c.contact->>'trade','phone',c.contact->>'phone','email',c.contact->>'email','active',true,'sharedWithManagers',false,'sourceUrl',c.contact->>'sourceUrl','sourcingImportKey',c.dedupe_key))
   on conflict(id) do nothing;
 end if;
 if not exists(select 1 from public.manager_vendor_records where id=local_id and manager_user_id=j.manager_user_id) then raise exception 'local contact owner mismatch'; end if;
 expiry := coalesce(c.expires_at,now()+interval '48 hours');
 insert into public.work_order_vendor_offers(work_order_id,vendor_directory_id,vendor_user_id,manager_user_id,status,expires_at)
  select w.id,local_id,vendor_user_id,j.manager_user_id,'sent',expiry from public.manager_vendor_records where id=local_id
  on conflict(work_order_id,vendor_directory_id) do nothing;
 proposal := public.vendor_coordination_action(jsonb_build_object('kind','enroll','work_order_id',w.id,'vendor_directory_id',local_id,'manager_user_id',j.manager_user_id,'actor_user_id',j.manager_user_id,'visit_type','repair','source_message_id','sourcing:'||w.id||':'||c.dedupe_key));
 update public.vendor_sourcing_candidates set local_directory_id=local_id,proposal_id=(proposal->>'id')::uuid,expires_at=expiry,updated_at=now() where id=c.id;
 return jsonb_build_object('local_directory_id',local_id,'proposal_id',proposal->>'id');
end $$;
revoke all on function public.enroll_vendor_sourcing_candidate(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enroll_vendor_sourcing_candidate(uuid,uuid) to service_role;

-- Lease-fenced completion and notification intent commit together.
create or replace function public.transition_vendor_sourcing(p_job_id uuid,p_lease_token uuid,p_patch jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.vendor_sourcing_jobs; e uuid; sender text;
begin
 select * into j from public.vendor_sourcing_jobs where id=p_job_id for update;
 if not found or j.lease_token is distinct from p_lease_token or j.lease_until<now() then return false; end if;
 update public.vendor_sourcing_jobs set state=coalesce(p_patch->>'state',state), stage=coalesce((p_patch->>'stage')::integer,stage),
 reason=p_patch->>'reason',next_run_at=coalesce((p_patch->>'next_run_at')::timestamptz,next_run_at),lease_token=null,lease_until=null,updated_at=now() where id=j.id;
 if p_patch->>'state' in ('quote_collected','needs_attention') then
  select email into sender from public.profiles where id=j.manager_user_id;
  insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,sender_user_id,sender_email,occurred_at,payload)
  values('vendor_sourcing:'||j.id||':'||(p_patch->>'state'),'work_order','sourcing_updated','maintenance',j.manager_user_id,j.work_order_id,j.manager_user_id,coalesce(sender,''),now(),jsonb_build_object('state',p_patch->>'state'))
  on conflict(event_key) do nothing returning id into e;
  if e is not null then
   insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,status,next_attempt_at,rendered)
   values(e,'manager',j.manager_user_id::text,j.manager_user_id,'pending',now(),jsonb_build_object('subject',case when p_patch->>'state'='quote_collected' then 'Service quote collected' else 'Vendor sourcing needs attention' end,'text',coalesce(p_patch->>'reason','Open Services to review.')));
  end if;
 end if; return true;
end $$;
revoke all on function public.transition_vendor_sourcing(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.transition_vendor_sourcing(uuid,uuid,jsonb) to service_role;
create or replace function public.update_vendor_sourcing_candidate(p_candidate_id uuid,p_lease_token uuid,p_patch jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.vendor_sourcing_jobs;
begin
 select j0.* into j from public.vendor_sourcing_jobs j0 join public.vendor_sourcing_candidates c on c.job_id=j0.id where c.id=p_candidate_id for update of j0;
 if not found or j.lease_token is distinct from p_lease_token or j.lease_until<now() or j.state not in ('queued','sourcing','waiting') then raise exception 'sourcing lease lost'; end if;
 update public.vendor_sourcing_candidates set status=coalesce(p_patch->>'status',status),reason=p_patch->>'reason',outbox_id=coalesce((p_patch->>'outbox_id')::uuid,outbox_id),updated_at=now() where id=p_candidate_id;
 return true;
end $$;
revoke all on function public.update_vendor_sourcing_candidate(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.update_vendor_sourcing_candidate(uuid,uuid,jsonb) to service_role;
-- New consent wakes exactly existing jobs, never sweeps historic services.
create or replace function public.wake_vendor_sourcing_consent() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.event_type='granted' and new.purpose in ('vendor_conversation','vendor_quote_request') then
  update public.vendor_sourcing_jobs j set state='queued',next_run_at=now(),lease_token=null,lease_until=null,attempts=0
   where j.manager_user_id=new.manager_user_id and j.state in ('needs_attention','waiting','queued') and exists
    (select 1 from public.vendor_sourcing_candidates c where c.job_id=j.id and c.status='permission_required' and regexp_replace(c.contact->>'phone','[^0-9]','','g')=regexp_replace(new.recipient_phone_key,'[^0-9]','','g'));
 end if; return new;
end $$;
revoke all on function public.wake_vendor_sourcing_consent() from public,anon,authenticated;
drop trigger if exists wake_vendor_sourcing_consent on public.sms_consent_events;
create trigger wake_vendor_sourcing_consent after insert on public.sms_consent_events for each row execute function public.wake_vendor_sourcing_consent();
-- A real exact quote arriving through either portal or SMS wakes terminal attention jobs.
create or replace function public.wake_vendor_sourcing_quote() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.scope is not null and new.labor_cents is not null and new.materials_cents is not null and new.consultation_fee_cents is not null and new.status not in ('declined','cancelled') then
  update public.vendor_sourcing_jobs set state='queued',next_run_at=now(),lease_token=null,lease_until=null where work_order_id=new.work_order_id and state in ('queued','waiting','needs_attention');
 end if; return new;
end $$;
revoke all on function public.wake_vendor_sourcing_quote() from public,anon,authenticated;
drop trigger if exists wake_vendor_sourcing_quote on public.vendor_coordination_proposals;
create trigger wake_vendor_sourcing_quote after update on public.vendor_coordination_proposals for each row execute function public.wake_vendor_sourcing_quote();
