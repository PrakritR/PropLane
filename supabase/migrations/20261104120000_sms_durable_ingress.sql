-- Owner-neutral transport. Payloads expire quickly and are retained at most 30 days.
create table if not exists public.sms_ingress_envelopes (
 id uuid primary key default gen_random_uuid(), message_sid text not null unique,
 wire_from text not null, wire_to text not null, payload_digest text not null,
 params jsonb not null, runtime text not null, account_sid text not null,
 status text not null default 'accepted' check (status in ('accepted','executing','prepared','completed','needs_review','expired')),
 attempts integer not null default 0, lease_token uuid, lease_until timestamptz,
 checkpoint_stage text not null default 'unstarted' check (checkpoint_stage in ('unstarted','safe','control','effect','delegated')), control_keyword text, delegated_sid text,
 reason text, next_attempt_at timestamptz not null default now(),
 received_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '24 hours', updated_at timestamptz not null default now()
);
create table if not exists public.sms_platform_replies (
 id uuid primary key default gen_random_uuid(), envelope_id uuid not null references public.sms_ingress_envelopes(id) on delete cascade,
 bubble_index integer not null, body text not null, media_urls jsonb not null default '[]', wire_from text not null, wire_to text not null,
 payload_digest text not null, runtime text not null, account_sid text not null, callback_token uuid not null unique default gen_random_uuid(),
 status text not null default 'prepared' check (status in ('prepared','submitting','accepted','delivery_unknown','blocked')),
 provider_sid text, submit_lease_until timestamptz, next_attempt_at timestamptz not null default now(), delivery_status text, delivery_rank integer not null default 0, attempt_count integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(envelope_id,bubble_index)
);
alter table public.sms_ingress_envelopes enable row level security;
alter table public.sms_platform_replies enable row level security;
revoke all on public.sms_ingress_envelopes, public.sms_platform_replies from public, anon, authenticated;
grant all on public.sms_ingress_envelopes, public.sms_platform_replies to service_role;

create or replace function public.sms_ingress_claim(p_id uuid, p_token uuid, p_runtime text, p_account text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare e public.sms_ingress_envelopes;
begin
 update sms_ingress_envelopes set status='executing', attempts=attempts+1, lease_token=p_token, lease_until=now()+interval '120 seconds', updated_at=now()
 where id=p_id and runtime=p_runtime and account_sid=p_account and status='accepted' and expires_at>now() and next_attempt_at<=now() and attempts<3 returning * into e;
 if not found then return null; end if;
 return jsonb_build_object('id',e.id,'params',e.params,'attempts',e.attempts,'checkpoint_stage',e.checkpoint_stage,'control_keyword',e.control_keyword,'delegated_sid',e.delegated_sid);
end $$;
revoke all on function public.sms_ingress_claim(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.sms_ingress_claim(uuid,uuid,text,text) to service_role;

-- Checkpoints are lease-guarded and a control decision cannot change on replay.
create or replace function public.sms_ingress_checkpoint(p_id uuid,p_token uuid,p_stage text,p_control text,p_delegated_sid text) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 if p_stage is null or p_stage not in ('safe','control','effect','delegated') or (p_stage='control' and (p_control is null or p_control not in ('STOP','START','HELP'))) then return false; end if;
 update sms_ingress_envelopes set checkpoint_stage=p_stage,
  control_keyword=coalesce(control_keyword,p_control), delegated_sid=coalesce(delegated_sid,p_delegated_sid), updated_at=now()
 where id=p_id and status='executing' and lease_token=p_token and lease_until>now() and expires_at>now()
  and (control_keyword is null or p_control is null or control_keyword=p_control)
  and (delegated_sid is null or p_delegated_sid is null or delegated_sid=p_delegated_sid)
  and (p_stage<>'delegated' or (p_delegated_sid=message_sid and exists (select 1 from sms_inbound_receipts r where r.message_sid=p_delegated_sid)))
  and (checkpoint_stage<>'delegated' or p_stage='delegated')
  and (checkpoint_stage<>'effect' or p_stage in ('effect','delegated'))
  and (checkpoint_stage<>'control' or p_stage='control');
 return found;
end $$;
revoke all on function public.sms_ingress_checkpoint(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.sms_ingress_checkpoint(uuid,uuid,text,text,text) to service_role;

-- Reconcile under row locks so callback/worker races cannot clear another refusal.
create or replace function public.sms_ingress_reconcile(p_runtime text,p_account text) returns void
language plpgsql security definer set search_path=public as $$
begin
 update sms_ingress_envelopes e set status='completed', reason=null, updated_at=now()
 where e.runtime=p_runtime and e.account_sid=p_account and e.status='needs_review' and e.reason='delegated_receipt'
 and exists (select 1 from sms_inbound_receipts r where r.message_sid=e.delegated_sid and r.status='completed');
 update sms_ingress_envelopes e set status='prepared', reason=null, updated_at=now()
 where e.runtime=p_runtime and e.account_sid=p_account and e.status='needs_review' and e.reason='delivery_unknown' and e.expires_at>now()
 and exists (select 1 from sms_platform_replies r where r.envelope_id=e.id)
 and not exists (select 1 from sms_platform_replies r where r.envelope_id=e.id and r.status not in ('accepted','prepared'));
end $$;
revoke all on function public.sms_ingress_reconcile(text,text) from public, anon, authenticated;
grant execute on function public.sms_ingress_reconcile(text,text) to service_role;

create or replace function public.sms_ingress_prepare(p_id uuid, p_token uuid, p_sender text, p_bubbles jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare e public.sms_ingress_envelopes; b jsonb; i integer := 0;
begin
 select * into e from sms_ingress_envelopes where id=p_id and lease_token=p_token and status='executing' and lease_until > now() and expires_at > now() for update;
 if not found then return false; end if;
 for b in select value from jsonb_array_elements(p_bubbles) loop
  insert into sms_platform_replies(envelope_id,bubble_index,body,media_urls,wire_from,wire_to,payload_digest,runtime,account_sid)
  values(e.id,i,b->>'body',coalesce(b->'mediaUrls','[]'::jsonb),p_sender,e.wire_from,encode(sha256(convert_to(b::text,'UTF8')),'hex'),e.runtime,e.account_sid);
  i := i + 1;
 end loop;
 update sms_ingress_envelopes set status=case when i=0 then 'completed' else 'prepared' end, lease_token=null, lease_until=null, updated_at=now() where id=e.id;
 return true;
end $$;
revoke all on function public.sms_ingress_prepare(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.sms_ingress_prepare(uuid,uuid,text,jsonb) to service_role;

create or replace function public.sms_platform_reply_callback(p_token uuid,p_runtime text,p_account text,p_from text,p_to text,p_sid text,p_status text,p_rank integer) returns boolean
language plpgsql security definer set search_path=public as $$
declare r public.sms_platform_replies;
begin
 select * into r from sms_platform_replies where callback_token=p_token for update;
 if not found or r.runtime<>p_runtime or r.account_sid<>p_account or r.wire_from<>p_from or r.wire_to<>p_to or (r.provider_sid is not null and r.provider_sid<>p_sid) or r.status not in ('submitting','delivery_unknown','accepted') then return false; end if;
 update sms_platform_replies set provider_sid=p_sid, status='accepted', delivery_status=case when delivery_status in ('delivered','read','failed','undelivered','canceled') then delivery_status when p_rank > delivery_rank then p_status else delivery_status end, delivery_rank=greatest(delivery_rank,p_rank), updated_at=now() where id=r.id;
 return true;
end $$;
revoke all on function public.sms_platform_reply_callback(uuid,text,text,text,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.sms_platform_reply_callback(uuid,text,text,text,text,text,text,integer) to service_role;

-- Invoked by scheduled maintenance; do not purge unexpired or outstanding work.
create or replace function public.purge_sms_ingress_retention() returns bigint
language plpgsql security definer set search_path=public as $$
declare n bigint;
begin
 delete from sms_ingress_envelopes where received_at < now() - interval '30 days';
 get diagnostics n = row_count; return n;
end $$;
revoke all on function public.purge_sms_ingress_retention() from public, anon, authenticated;
grant execute on function public.purge_sms_ingress_retention() to service_role;
