-- Private identity, bearer capabilities, quote email delivery, and scoped SMS consent.
-- This is additive; it creates no sender assignment and sends no messages.

create table if not exists public.vendor_outreach_workspace_profiles (
  manager_user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'software' check (mode in ('software','managed')),
  managed_display_name text,
  managed_legal_name text,
  managed_email text,
  managed_work_phone text,
  managed_messaging_service_sid text,
  version integer not null default 1 check (version > 0),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz,
  updated_at timestamptz not null default now(),
  check (mode <> 'managed' or (nullif(trim(managed_display_name),'') is not null and nullif(trim(managed_legal_name),'') is not null and managed_email is not null and managed_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'))
);
alter table public.vendor_outreach_workspace_profiles enable row level security;
revoke all on public.vendor_outreach_workspace_profiles from public,anon,authenticated;
grant select,insert,update,delete on public.vendor_outreach_workspace_profiles to service_role;

create table if not exists public.vendor_quote_contact_capabilities (
  id uuid primary key default gen_random_uuid(),
  token_digest text not null unique check (token_digest ~ '^[a-f0-9]{64}$'),
  token_nonce text not null check (token_nonce ~ '^[a-f0-9]{64}$'),
  purpose text not null default 'response' check (purpose in ('response','inbound_reply','withdrawal')),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.vendor_sourcing_jobs(id) on delete cascade,
  candidate_id uuid not null references public.vendor_sourcing_candidates(id) on delete cascade,
  work_order_id text not null references public.portal_work_order_records(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete cascade,
  proposal_id uuid not null references public.vendor_coordination_proposals(id) on delete cascade,
  recipient_email text not null,
  sender_mode text not null check (sender_mode in ('software','managed')),
  sender_version integer not null check (sender_version > 0),
  sender_snapshot jsonb not null check (jsonb_typeof(sender_snapshot)='object'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at)
);
create index if not exists vendor_quote_capability_candidate_idx on public.vendor_quote_contact_capabilities(candidate_id,created_at desc);
create index if not exists vendor_quote_capability_owner_idx on public.vendor_quote_contact_capabilities(manager_user_id,work_order_id);

create table if not exists public.vendor_quote_contact_sessions (
  id uuid primary key default gen_random_uuid(),
  session_digest text not null unique check (session_digest ~ '^[a-f0-9]{64}$'),
  capability_id uuid not null references public.vendor_quote_contact_capabilities(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vendor_quote_email_permissions (
  id uuid primary key default gen_random_uuid(),
  normalized_email text not null,
  sender_key text not null,
  manager_user_id uuid references auth.users(id) on delete cascade,
  evidence_kind text not null check (evidence_kind in ('published_quote_invitation','direct_permission','recipient_withdrawal','hard_bounce','complaint')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  allowed_follow_up boolean not null default false,
  active boolean not null default true,
  event_id text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (normalized_email = lower(trim(normalized_email)))
);
drop index if exists public.vendor_quote_email_permission_event_unique;
create unique index vendor_quote_email_permission_event_unique on public.vendor_quote_email_permissions(event_id);
create index if not exists vendor_quote_email_permission_lookup on public.vendor_quote_email_permissions(normalized_email,sender_key,active,created_at desc);

create table if not exists public.vendor_quote_email_outbox (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.vendor_sourcing_candidates(id) on delete cascade,
  job_id uuid not null references public.vendor_sourcing_jobs(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  capability_id uuid references public.vendor_quote_contact_capabilities(id) on delete set null,
  message_kind text not null check (message_kind in ('initial','reminder')),
  revision integer not null default 1 check (revision > 0),
  idempotency_key text not null unique,
  job_lease_token uuid not null,
  recipient_email text not null,
  sender_key text not null,
  sender_version integer not null,
  evidence_version integer not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued' check (status in ('queued','submitting','accepted','delivered','failed_before_send','unknown','suppressed','expired','canceled')),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  provider_message_id text,
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(candidate_id,message_kind,revision)
);
create index if not exists vendor_quote_email_outbox_due on public.vendor_quote_email_outbox(status,next_attempt_at) where status in ('queued','unknown');
create unique index if not exists vendor_quote_email_provider_id_unique on public.vendor_quote_email_outbox(provider_message_id) where provider_message_id is not null;

create or replace function public.claim_vendor_quote_email_outbox(
 p_candidate_id uuid,p_job_lease_token uuid,p_capability_id uuid,p_recipient_email text,p_sender_key text,
 p_sender_version integer,p_evidence_version integer,p_payload_hash text,p_idempotency_key text
) returns public.vendor_quote_email_outbox language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_sourcing_candidates%rowtype; j public.vendor_sourcing_jobs%rowtype; w public.portal_work_order_records%rowtype; o public.vendor_quote_email_outbox%rowtype; next_lease uuid;
begin
 select * into c from public.vendor_sourcing_candidates where id=p_candidate_id;
 if not found then raise exception 'vendor quote candidate unavailable'; end if;
 select * into j from public.vendor_sourcing_jobs where id=c.job_id for update;
 if not found or j.lease_token is distinct from p_job_lease_token or j.lease_until<=now() or j.manager_user_id<>c.manager_user_id or j.state not in ('queued','sourcing','waiting') then raise exception 'sourcing lease lost'; end if;
 select * into w from public.portal_work_order_records where id=j.work_order_id and manager_user_id=j.manager_user_id for update;
 if not found or coalesce(w.row_data->>'bucket','')<>'open' or nullif(w.row_data->>'vendorId','') is not null or w.row_data->>'selfAssigned'='true' then raise exception 'sourcing service stopped'; end if;
 if not exists(select 1 from public.manager_automation_settings a where a.manager_user_id=j.manager_user_id and a.vendor_dispatch->>'quoteSourcingEnabled'='true') then raise exception 'sourcing paused'; end if;
 if c.job_id<>j.id or c.manager_user_id<>j.manager_user_id or c.local_directory_id is null or c.proposal_id is null or lower(trim(c.contact->>'email'))<>lower(trim(p_recipient_email)) or c.contact->'emailEvidence'->>'version'<>p_evidence_version::text then raise exception 'quote contact changed'; end if;
 if not exists(select 1 from public.manager_vendor_records d where d.id=c.local_directory_id and d.manager_user_id=j.manager_user_id and coalesce(d.row_data->>'active','true')<>'false' and (d.vendor_user_id is null or d.manager_user_id=j.manager_user_id)) then raise exception 'vendor directory identity changed'; end if;
 if not exists(select 1 from public.work_order_vendor_offers offer where offer.work_order_id=j.work_order_id and offer.manager_user_id=j.manager_user_id and offer.vendor_directory_id=c.local_directory_id and offer.status='sent' and offer.expires_at>now()) then raise exception 'vendor offer unavailable'; end if;
 if not exists(select 1 from public.vendor_coordination_proposals p where p.id=c.proposal_id and p.work_order_id=j.work_order_id and p.manager_user_id=j.manager_user_id and p.vendor_directory_id=c.local_directory_id and p.status not in ('approved','declined','cancelled') and not p.manager_takeover) then raise exception 'vendor quote unavailable'; end if;
 if not exists(select 1 from public.vendor_quote_contact_capabilities cap where cap.id=p_capability_id and cap.manager_user_id=j.manager_user_id and cap.job_id=j.id and cap.candidate_id=c.id and cap.work_order_id=j.work_order_id and cap.vendor_directory_id=c.local_directory_id and cap.proposal_id=c.proposal_id and cap.recipient_email=lower(trim(p_recipient_email)) and cap.purpose='response' and cap.revoked_at is null and cap.expires_at>now()) then raise exception 'quote capability unavailable'; end if;
 if exists(select 1 from public.vendor_quote_email_permissions p where p.normalized_email=lower(trim(p_recipient_email)) and p.active and p.evidence_kind in ('recipient_withdrawal','hard_bounce','complaint') and (p.sender_key='*' or p.sender_key=p_sender_key)) then raise exception 'recipient email suppressed'; end if;
 insert into public.vendor_quote_email_outbox(candidate_id,job_id,manager_user_id,capability_id,message_kind,revision,idempotency_key,job_lease_token,recipient_email,sender_key,sender_version,evidence_version,payload_hash,status)
 values(c.id,j.id,j.manager_user_id,p_capability_id,'initial',1,p_idempotency_key,j.lease_token,lower(trim(p_recipient_email)),p_sender_key,p_sender_version,p_evidence_version,p_payload_hash,'queued')
 on conflict(candidate_id,message_kind,revision) do nothing;
 select * into o from public.vendor_quote_email_outbox where candidate_id=c.id and message_kind='initial' and revision=1 for update;
 if not found then raise exception 'vendor quote outbox unavailable'; end if;
 if o.idempotency_key<>p_idempotency_key or o.recipient_email<>lower(trim(p_recipient_email)) or o.payload_hash<>p_payload_hash or o.sender_key<>p_sender_key or o.sender_version<>p_sender_version or o.evidence_version<>p_evidence_version then raise exception 'vendor quote send replay changed'; end if;
 if o.status in ('accepted','delivered','suppressed','expired','canceled','failed_before_send') then return o; end if;
 if o.status='unknown' and o.created_at<=now()-interval '24 hours' then return o; end if;
 if o.status='submitting' and o.lease_until>now() then return o; end if;
 next_lease:=gen_random_uuid();
 update public.vendor_quote_email_outbox set status='submitting',job_lease_token=j.lease_token,lease_token=next_lease,lease_until=now()+interval '2 minutes',attempt_count=attempt_count+1,updated_at=now()
 where id=o.id returning * into o;
 update public.vendor_sourcing_candidates set status='email_submitting',outbox_id=o.id,updated_at=now() where id=c.id;
 return o;
end $$;
revoke all on function public.claim_vendor_quote_email_outbox(uuid,uuid,uuid,text,text,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.claim_vendor_quote_email_outbox(uuid,uuid,uuid,text,text,integer,integer,text,text) to service_role;

create or replace function public.authorize_vendor_quote_email_outbox(p_outbox_id uuid,p_delivery_lease_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.vendor_quote_email_outbox%rowtype; c public.vendor_sourcing_candidates%rowtype; j public.vendor_sourcing_jobs%rowtype; w public.portal_work_order_records%rowtype;
begin
 select * into o from public.vendor_quote_email_outbox where id=p_outbox_id and status='submitting' and lease_token=p_delivery_lease_token and lease_until>now() for update;
 if not found then return false; end if;
 select * into c from public.vendor_sourcing_candidates where id=o.candidate_id;
 select * into j from public.vendor_sourcing_jobs where id=o.job_id for update;
 if not found or j.lease_token is distinct from o.job_lease_token or j.lease_until<=now() or j.manager_user_id<>o.manager_user_id or j.state not in ('queued','sourcing','waiting') then return false; end if;
 select * into w from public.portal_work_order_records where id=j.work_order_id and manager_user_id=j.manager_user_id for update;
 if not found or coalesce(w.row_data->>'bucket','')<>'open' or nullif(w.row_data->>'vendorId','') is not null or w.row_data->>'selfAssigned'='true' then return false; end if;
 if not exists(select 1 from public.manager_automation_settings a where a.manager_user_id=j.manager_user_id and a.vendor_dispatch->>'quoteSourcingEnabled'='true') or
    not exists(select 1 from public.manager_vendor_records d where d.id=c.local_directory_id and d.manager_user_id=j.manager_user_id and coalesce(d.row_data->>'active','true')<>'false') or
    not exists(select 1 from public.vendor_coordination_proposals p where p.id=c.proposal_id and p.manager_user_id=j.manager_user_id and p.status not in ('approved','declined','cancelled') and not p.manager_takeover) or
    not exists(select 1 from public.work_order_vendor_offers offer where offer.work_order_id=j.work_order_id and offer.manager_user_id=j.manager_user_id and offer.vendor_directory_id=c.local_directory_id and offer.status='sent' and offer.expires_at>now()) or
    not exists(select 1 from public.vendor_quote_contact_capabilities cap where cap.id=o.capability_id and cap.manager_user_id=j.manager_user_id and cap.sender_version=o.sender_version and cap.recipient_email=o.recipient_email and cap.revoked_at is null and cap.expires_at>now()) or
    lower(trim(c.contact->>'email'))<>o.recipient_email or c.contact->'emailEvidence'->>'version'<>o.evidence_version::text or
    exists(select 1 from public.vendor_quote_email_permissions p where p.normalized_email=o.recipient_email and p.active and p.evidence_kind in ('recipient_withdrawal','hard_bounce','complaint') and (p.sender_key='*' or p.sender_key=o.sender_key)) then return false; end if;
 return true;
end $$;
revoke all on function public.authorize_vendor_quote_email_outbox(uuid,uuid) from public,anon,authenticated;
grant execute on function public.authorize_vendor_quote_email_outbox(uuid,uuid) to service_role;

create or replace function public.finish_vendor_quote_email_outbox(p_outbox_id uuid,p_delivery_lease_token uuid,p_state text,p_provider_message_id text default null,p_error_code text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.vendor_quote_email_outbox%rowtype; c public.vendor_sourcing_candidates%rowtype;
begin
 if p_state not in ('accepted','failed_before_send','unknown') then raise exception 'invalid quote delivery state'; end if;
 if p_state='accepted' and (p_provider_message_id is null or length(trim(p_provider_message_id)) not between 1 and 200 or p_provider_message_id ~ '[[:cntrl:]]') then p_state:='unknown'; p_provider_message_id:=null; p_error_code:='invalid_provider_id'; end if;
 select * into o from public.vendor_quote_email_outbox where id=p_outbox_id and status='submitting' and lease_token=p_delivery_lease_token for update;
 if not found then return false; end if;
 update public.vendor_quote_email_outbox set status=p_state,provider_message_id=p_provider_message_id,provider_accepted_at=case when p_state='accepted' then now() else null end,
   last_error_code=left(p_error_code,120),lease_token=null,lease_until=null,next_attempt_at=case when p_state='unknown' and created_at>now()-interval '24 hours' then now()+interval '2 minutes' else null end,updated_at=now()
   where id=o.id and lease_token=p_delivery_lease_token;
 select * into c from public.vendor_sourcing_candidates where id=o.candidate_id;
 update public.vendor_sourcing_candidates set status=case p_state when 'accepted' then 'email_sent' when 'unknown' then 'email_delivery_unknown' else 'email_failed' end,reason=case when p_state='failed_before_send' then left(p_error_code,120) else null end,updated_at=now() where id=o.candidate_id;
 return true;
end $$;
revoke all on function public.finish_vendor_quote_email_outbox(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_vendor_quote_email_outbox(uuid,uuid,text,text,text) to service_role;

create table if not exists public.vendor_quote_email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  outbox_id uuid not null references public.vendor_quote_email_outbox(id) on delete cascade,
  provider_message_id text not null,
  event_kind text not null check (event_kind in ('delivered','bounced','complained')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Provider receipt, terminal suppression, and delivery state commit together.
-- Reapplying an identical old receipt also repairs pre-RPC partial callback state.
create or replace function public.apply_vendor_quote_email_delivery_event(
 p_event_id text,p_provider_message_id text,p_event_kind text,p_occurred_at timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.vendor_quote_email_outbox%rowtype; e public.vendor_quote_email_delivery_events%rowtype;
begin
 if nullif(trim(p_event_id),'') is null or nullif(trim(p_provider_message_id),'') is null or
    p_event_kind is null or p_event_kind not in ('delivered','bounced','complained') or p_occurred_at is null or not isfinite(p_occurred_at) then
   raise exception 'invalid quote delivery event';
 end if;
 select * into o from public.vendor_quote_email_outbox where provider_message_id=p_provider_message_id for update;
 if not found then return false; end if;
 insert into public.vendor_quote_email_delivery_events(event_id,outbox_id,provider_message_id,event_kind,occurred_at)
 values(p_event_id,o.id,p_provider_message_id,p_event_kind,p_occurred_at) on conflict(event_id) do nothing;
 select * into e from public.vendor_quote_email_delivery_events where event_id=p_event_id;
 if e.outbox_id is distinct from o.id or e.provider_message_id is distinct from p_provider_message_id or
    e.event_kind is distinct from p_event_kind or e.occurred_at is distinct from p_occurred_at then
   raise exception 'quote delivery event replay changed';
 end if;
 if p_event_kind='delivered' then
   update public.vendor_quote_email_outbox set status='delivered',delivered_at=coalesce(delivered_at,p_occurred_at),updated_at=now()
   where id=o.id and status<>'suppressed';
 else
   update public.vendor_quote_email_outbox set status='suppressed',updated_at=now() where id=o.id;
   insert into public.vendor_quote_email_permissions(normalized_email,sender_key,evidence_kind,evidence,active,event_id)
   values(lower(trim(o.recipient_email)),'*',case when p_event_kind='bounced' then 'hard_bounce' else 'complaint' end,
     jsonb_build_object('providerMessageId',p_provider_message_id),true,'provider:'||p_event_id)
   on conflict(event_id) do nothing;
 end if;
 return true;
end $$;
revoke all on function public.apply_vendor_quote_email_delivery_event(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_vendor_quote_email_delivery_event(text,text,text,timestamptz) to service_role;

create table if not exists public.vendor_quote_responses (
  id uuid primary key default gen_random_uuid(),
  capability_id uuid not null references public.vendor_quote_contact_capabilities(id) on delete cascade,
  candidate_id uuid not null references public.vendor_sourcing_candidates(id) on delete cascade,
  proposal_id uuid not null references public.vendor_coordination_proposals(id) on delete cascade,
  request_version integer not null,
  response_version integer not null,
  response jsonb not null check (jsonb_typeof(response)='object'),
  submitted_at timestamptz not null default now(),
  unique(candidate_id,request_version)
);

create table if not exists public.vendor_quote_sms_consent_challenges (
  id uuid primary key default gen_random_uuid(),
  capability_id uuid not null references public.vendor_quote_contact_capabilities(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references public.vendor_sourcing_candidates(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete cascade,
  proposal_id uuid not null references public.vendor_coordination_proposals(id) on delete cascade,
  requested_phone text not null check (requested_phone ~ '^\+[1-9][0-9]{7,14}$'),
  work_phone text not null check (work_phone ~ '^\+[1-9][0-9]{7,14}$'),
  messaging_service_sid text not null,
  sender_version integer not null,
  proposal_version integer not null,
  code_digest text not null check (code_digest ~ '^[a-f0-9]{64}$'),
  wording_version text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  revoked_at timestamptz,
  inbound_event_id text unique,
  created_at timestamptz not null default now()
);
create index if not exists vendor_quote_sms_challenge_live on public.vendor_quote_sms_consent_challenges(candidate_id,created_at desc) where consumed_at is null and revoked_at is null;

create table if not exists public.vendor_quote_sms_consent_events (
  id uuid primary key default gen_random_uuid(),
  capability_id uuid not null references public.vendor_quote_contact_capabilities(id) on delete cascade,
  challenge_id uuid not null unique references public.vendor_quote_sms_consent_challenges(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references public.vendor_sourcing_candidates(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete cascade,
  proposal_id uuid not null references public.vendor_coordination_proposals(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  work_phone text not null,
  messaging_service_sid text not null,
  purpose text not null default 'this_service_quote',
  wording_version text not null,
  source_event_id text not null unique,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

do $$ declare t text; begin
  foreach t in array array['vendor_quote_contact_capabilities','vendor_quote_contact_sessions','vendor_quote_email_permissions','vendor_quote_email_outbox','vendor_quote_email_delivery_events','vendor_quote_responses','vendor_quote_sms_consent_challenges','vendor_quote_sms_consent_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
  end loop;
end $$;

-- Staff-only, audited sender-mode assignment. Profile role is deliberately not consulted.
create or replace function public.assign_vendor_outreach_mode(
  p_manager_user_id uuid,p_mode text,p_admin_user_id uuid,
  p_display_name text default null,p_legal_name text default null,p_email text default null,
  p_work_phone text default null,p_messaging_service_sid text default null
) returns public.vendor_outreach_workspace_profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.vendor_outreach_workspace_profiles%rowtype;
begin
  if p_admin_user_id is null or not exists(select 1 from public.profile_roles where user_id=p_admin_user_id and role='admin') then raise exception 'staff authorization required'; end if;
  if p_manager_user_id is null or p_mode not in ('managed','software') then raise exception 'invalid sender assignment'; end if;
  if p_mode='managed' and (nullif(trim(p_display_name),'') is null or nullif(trim(p_legal_name),'') is null or coalesce(p_email,'') !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' or coalesce(p_work_phone,'') !~ '^\+[1-9][0-9]{7,14}$' or nullif(trim(p_messaging_service_sid),'') is null) then raise exception 'managed sender identity incomplete'; end if;
  insert into public.vendor_outreach_workspace_profiles(manager_user_id,mode,managed_display_name,managed_legal_name,managed_email,managed_work_phone,managed_messaging_service_sid,assigned_by,assigned_at)
  values(p_manager_user_id,p_mode,nullif(trim(p_display_name),''),nullif(trim(p_legal_name),''),lower(trim(p_email)),p_work_phone,p_messaging_service_sid,p_admin_user_id,now())
  on conflict(manager_user_id) do update set mode=excluded.mode,managed_display_name=excluded.managed_display_name,managed_legal_name=excluded.managed_legal_name,managed_email=excluded.managed_email,managed_work_phone=excluded.managed_work_phone,managed_messaging_service_sid=excluded.managed_messaging_service_sid,version=vendor_outreach_workspace_profiles.version+1,assigned_by=excluded.assigned_by,assigned_at=now(),updated_at=now()
  returning * into r;
  update public.vendor_quote_contact_capabilities set revoked_at=now() where manager_user_id=p_manager_user_id and revoked_at is null;
  update public.vendor_quote_contact_sessions set revoked_at=now() where capability_id in (select id from public.vendor_quote_contact_capabilities where manager_user_id=p_manager_user_id);
  update public.vendor_quote_email_outbox set status='canceled',updated_at=now() where manager_user_id=p_manager_user_id and status in ('queued','submitting');
  update public.vendor_quote_sms_consent_challenges set revoked_at=now() where manager_user_id=p_manager_user_id and consumed_at is null;
  return r;
end $$;
revoke all on function public.assign_vendor_outreach_mode(uuid,text,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.assign_vendor_outreach_mode(uuid,text,uuid,text,text,text,text,text) to service_role;

-- Re-read the complete disclosed identity under row locks at the mutation boundary.
-- Row locks serialize profile/mailbox/property/line changes with challenge consumption.
create or replace function public.vendor_quote_sender_is_current(p_capability_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_quote_contact_capabilities%rowtype; snap jsonb; workspace uuid;
  identity public.vendor_outreach_workspace_profiles%rowtype; name text; mailbox text;
  line public.manager_sms_numbers%rowtype;
begin
  select * into c from public.vendor_quote_contact_capabilities where id=p_capability_id;
  if not found then return false; end if;
  snap:=c.sender_snapshot;
  if snap->>'managerUserId' is distinct from c.manager_user_id::text or snap->>'mode' is distinct from c.sender_mode or snap->>'version' is distinct from c.sender_version::text then return false; end if;
  select prop.workspace_id into workspace from public.portal_work_order_records w
    join public.manager_property_records prop on prop.id=w.property_id and prop.manager_user_id=w.manager_user_id
    where w.id=c.work_order_id and w.manager_user_id=c.manager_user_id for share of w,prop;
  if workspace is null or snap->>'workspaceId' is distinct from workspace::text then return false; end if;
  select * into identity from public.vendor_outreach_workspace_profiles where manager_user_id=c.manager_user_id for share;
  if coalesce(identity.mode,'software') is distinct from c.sender_mode or coalesce(identity.version,1) is distinct from c.sender_version then return false; end if;
  select coalesce(nullif(trim(full_name),''),'Property manager') into name from public.profiles where id=c.manager_user_id for share;
  if not found then return false; end if;
  select coalesce(nullif(lower(trim(mailbox_local)),''),'assistant+'||inbox_token) into mailbox
    from public.manager_assistant_emails where manager_user_id=c.manager_user_id and workspace_id=workspace and provision_state='active' for share;
  if not found or split_part(lower(coalesce(snap->>'email','')),'@',1) is distinct from mailbox then return false; end if;
  select * into line from public.manager_sms_numbers where manager_user_id=c.manager_user_id and workspace_id=workspace for share;
  if c.sender_mode='managed' then
    if snap->>'displayName' is distinct from trim(identity.managed_display_name) or snap->>'legalName' is distinct from trim(identity.managed_legal_name)
      or lower(snap->>'email') is distinct from lower(trim(identity.managed_email))
      or snap->>'workPhone' is distinct from identity.managed_work_phone or snap->>'messagingServiceSid' is distinct from identity.managed_messaging_service_sid then return false; end if;
  elsif snap->>'displayName' is distinct from name or snap->>'legalName' is distinct from name then return false;
  end if;
  if line.provision_state='active' and line.released_at is null and line.messaging_service_sid is not null then
    return snap->>'workPhone' is not distinct from line.phone_number and snap->>'messagingServiceSid' is not distinct from line.messaging_service_sid;
  end if;
  return c.sender_mode='software' and snap->>'workPhone' is null and snap->>'messagingServiceSid' is null;
end $$;
revoke all on function public.vendor_quote_sender_is_current(uuid) from public,anon,authenticated;
grant execute on function public.vendor_quote_sender_is_current(uuid) to service_role;

-- A quote capability can mutate only its own proposal and only quote fields/windows/decline.
-- It cannot act as a manager, confirm a vendor, book, or see another candidate.
create or replace function public.vendor_quote_capability_action(p_session_digest text,p_action jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.vendor_quote_contact_sessions%rowtype; c public.vendor_quote_contact_capabilities%rowtype;
        p public.vendor_coordination_proposals%rowtype; w public.portal_work_order_records%rowtype; kind text; v integer; q jsonb; win jsonb; st timestamptz; en timestamptz; source text; input_hash text; service_id text; prior_hash text;
begin
  select cap.work_order_id into service_id from public.vendor_quote_contact_sessions sess join public.vendor_quote_contact_capabilities cap on cap.id=sess.capability_id where sess.session_digest=p_session_digest;
  if service_id is null then raise exception 'quote unavailable'; end if;
  perform public.lock_vendor_service(service_id);
  select * into s from public.vendor_quote_contact_sessions where session_digest=p_session_digest and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'quote unavailable'; end if;
  select * into c from public.vendor_quote_contact_capabilities where id=s.capability_id and revoked_at is null and consumed_at is null and expires_at>now() for update;
  if not found or c.purpose<>'response' then raise exception 'quote unavailable'; end if;
  if not public.vendor_quote_sender_is_current(c.id) then raise exception 'quote unavailable'; end if;
  if not exists(select 1 from public.vendor_sourcing_jobs j where j.id=c.job_id and j.manager_user_id=c.manager_user_id and j.work_order_id=c.work_order_id and j.state in ('queued','sourcing','waiting','quote_collected','needs_attention')) then raise exception 'quote unavailable'; end if;
  if not exists(select 1 from public.vendor_sourcing_candidates x where x.id=c.candidate_id and x.job_id=c.job_id and x.manager_user_id=c.manager_user_id and x.local_directory_id=c.vendor_directory_id and x.proposal_id=c.proposal_id and x.expires_at>now()) then raise exception 'quote unavailable'; end if;
  if not exists(select 1 from public.manager_vendor_records d where d.id=c.vendor_directory_id and d.manager_user_id=c.manager_user_id and coalesce(d.row_data->>'active','true')<>'false') then raise exception 'quote unavailable'; end if;
  if not exists(select 1 from public.work_order_vendor_offers o where o.work_order_id=c.work_order_id and o.manager_user_id=c.manager_user_id and o.vendor_directory_id=c.vendor_directory_id and o.status='sent' and o.expires_at>now()) then raise exception 'quote unavailable'; end if;
  if coalesce((select i.mode from public.vendor_outreach_workspace_profiles i where i.manager_user_id=c.manager_user_id),'software')<>c.sender_mode or coalesce((select i.version from public.vendor_outreach_workspace_profiles i where i.manager_user_id=c.manager_user_id),1)<>c.sender_version then raise exception 'quote unavailable'; end if;
  select * into p from public.vendor_coordination_proposals where id=c.proposal_id and work_order_id=c.work_order_id and manager_user_id=c.manager_user_id and vendor_directory_id=c.vendor_directory_id for update;
  if not found then raise exception 'quote unavailable'; end if;
  select * into w from public.portal_work_order_records where id=c.work_order_id and manager_user_id=c.manager_user_id for update;
  if not found or coalesce(w.row_data->>'bucket','')<>'open' or nullif(w.row_data->>'vendorId','') is not null or w.row_data->>'selfAssigned'='true' or p.manager_takeover or p.accepted_bid_id is not null or p.status in ('approved','cancelled','declined') then raise exception 'quote unavailable'; end if;
  kind:=p_action->>'kind'; v:=nullif(p_action->>'expected_version','')::integer;
  source:=left(coalesce(nullif(trim(p_action->>'source_message_id'),''),'vendor-quote:'||c.id::text||':'||p.version::text||':'||kind),200);
  input_hash:=md5((p_action-'expected_version')::text);
  select o.input_hash into prior_hash from public.vendor_coordination_operations o where o.proposal_id=p.id and o.source_message_id=source and o.action_kind=kind;
  if found then
    if prior_hash<>input_hash then raise exception 'message action reused with changed input'; end if;
    return to_jsonb(p);
  end if;
  if v is distinct from p.version then raise exception 'stale coordination version'; end if;
  if kind='revise_quote' then
    q:=p_action->'quote';
    if jsonb_typeof(q) is distinct from 'object' or nullif(trim(q->>'scope'),'') is null or length(q->>'scope')>4000 or length(coalesce(q->>'exclusions',''))>4000 then raise exception 'invalid coordination quote'; end if;
    if coalesce(q->>'laborCents','') !~ '^[0-9]{1,10}$' or coalesce(q->>'materialsCents','') !~ '^[0-9]{1,10}$' or coalesce(q->>'consultationFeeCents','') !~ '^[0-9]{1,10}$' then raise exception 'invalid coordination quote'; end if;
    if (q->>'laborCents')::bigint>1000000000 or (q->>'materialsCents')::bigint>1000000000 or (q->>'consultationFeeCents')::bigint>1000000000 then raise exception 'quote exceeds limit'; end if;
    if nullif(p_action->>'duration_minutes','') is null or (p_action->>'duration_minutes')::integer not between 15 and 480 then raise exception 'invalid coordination quote'; end if;
    if p.visit_type='repair' and (q->>'laborCents')::bigint+(q->>'materialsCents')::bigint<=0 then raise exception 'invalid quote total'; end if;
    update public.vendor_coordination_proposals set labor_cents=(q->>'laborCents')::integer,materials_cents=(q->>'materialsCents')::integer,consultation_fee_cents=(q->>'consultationFeeCents')::integer,scope=trim(q->>'scope'),exclusions=coalesce(trim(q->>'exclusions'),''),duration_minutes=(p_action->>'duration_minutes')::integer,quote_revision=quote_revision+1,vendor_confirmed_revision=null,resident_confirmed_revision=null,status='collecting',version=version+1,updated_at=now() where id=p.id;
  elsif kind='replace_quote_form' then
    q:=p_action->'quote';
    if jsonb_typeof(q) is distinct from 'object' or length(coalesce(q->>'scope',''))>4000 or length(coalesce(q->>'exclusions',''))>4000 then raise exception 'invalid coordination quote'; end if;
    if (q ? 'laborCents' and q->>'laborCents' is not null and q->>'laborCents' !~ '^[0-9]{1,10}$') or
       (q ? 'materialsCents' and q->>'materialsCents' is not null and q->>'materialsCents' !~ '^[0-9]{1,10}$') or
       (q ? 'consultationFeeCents' and q->>'consultationFeeCents' is not null and q->>'consultationFeeCents' !~ '^[0-9]{1,10}$') then raise exception 'invalid coordination quote'; end if;
    if coalesce(nullif(q->>'laborCents','')::bigint,0)>1000000000 or coalesce(nullif(q->>'materialsCents','')::bigint,0)>1000000000 or coalesce(nullif(q->>'consultationFeeCents','')::bigint,0)>1000000000 then raise exception 'quote exceeds limit'; end if;
    if nullif(p_action->>'duration_minutes','') is not null and (p_action->>'duration_minutes')::integer not between 15 and 480 then raise exception 'invalid coordination quote'; end if;
    if p.visit_type='repair' and nullif(q->>'laborCents','') is not null and nullif(q->>'materialsCents','') is not null and (q->>'laborCents')::bigint+(q->>'materialsCents')::bigint<=0 then raise exception 'invalid quote total'; end if;
    if jsonb_typeof(p_action->'windows') is distinct from 'array' or jsonb_array_length(p_action->'windows')>32 then raise exception 'invalid windows'; end if;
    for win in select value from jsonb_array_elements(p_action->'windows') loop
      if nullif(win->>'startIso','') is null or nullif(win->>'endIso','') is null then raise exception 'window endpoints required'; end if;
      st:=(win->>'startIso')::timestamptz; en:=(win->>'endIso')::timestamptz;
      if en<=st or st<=now() or en-st>interval '8 hours' or nullif(trim(win->>'timeZone'),'') is null then raise exception 'invalid window'; end if;
    end loop;
    update public.vendor_coordination_proposals set
      labor_cents=nullif(q->>'laborCents','')::integer,
      materials_cents=nullif(q->>'materialsCents','')::integer,
      consultation_fee_cents=nullif(q->>'consultationFeeCents','')::integer,
      scope=nullif(trim(q->>'scope'),''),
      exclusions=nullif(trim(q->>'exclusions'),''),
      duration_minutes=nullif(p_action->>'duration_minutes','')::integer,
      vendor_windows=p_action->'windows',resident_windows='[]'::jsonb,selected_start_at=null,
      quote_revision=quote_revision+1,vendor_confirmed_revision=null,resident_confirmed_revision=null,
      status='collecting',version=version+1,updated_at=now()
    where id=p.id;
  elsif kind='submit_vendor_windows' then
    if jsonb_typeof(p_action->'windows') is distinct from 'array' or jsonb_array_length(p_action->'windows')>32 then raise exception 'invalid windows'; end if;
    for win in select value from jsonb_array_elements(p_action->'windows') loop
      if nullif(win->>'startIso','') is null or nullif(win->>'endIso','') is null then raise exception 'window endpoints required'; end if;
      st:=(win->>'startIso')::timestamptz; en:=(win->>'endIso')::timestamptz;
      if en<=st or st<=now() or en-st>interval '8 hours' or nullif(trim(win->>'timeZone'),'') is null then raise exception 'invalid window'; end if;
    end loop;
    update public.vendor_coordination_proposals set vendor_windows=p_action->'windows',version=version+1,updated_at=now() where id=p.id;
  elsif kind='decline_vendor' then
    update public.vendor_coordination_proposals set status='declined',revision_reason=left(coalesce(nullif(trim(p_action->>'reason'),''),'Vendor declined this service quote.'),1000),version=version+1,updated_at=now() where id=p.id;
    update public.work_order_vendor_offers set status='declined',declined_reason='Vendor declined this service quote.',declined_at=now(),updated_at=now() where work_order_id=c.work_order_id and manager_user_id=c.manager_user_id and vendor_directory_id=c.vendor_directory_id and status='sent';
    update public.vendor_sourcing_candidates set status='declined',reason='Vendor declined this service quote.',updated_at=now() where id=c.candidate_id;
  elsif kind='record_question' then
    if length(coalesce(p_action->>'question',''))>2000 then raise exception 'invalid question'; end if;
    update public.vendor_coordination_proposals set source_message_ids=case when source_message_ids ? source then source_message_ids else source_message_ids||jsonb_build_array(source) end,version=version+1,updated_at=now() where id=p.id;
  else raise exception 'quote action not allowed'; end if;
  insert into public.vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash) values(p.id,source,kind,input_hash);
  select * into p from public.vendor_coordination_proposals where id=p.id;
  return to_jsonb(p);
end $$;
revoke all on function public.vendor_quote_capability_action(text,jsonb) from public,anon,authenticated;
grant execute on function public.vendor_quote_capability_action(text,jsonb) to service_role;

-- The public form persists its exact response and applies quote/windows under one service lock.
-- Identical retries return the existing row; changed input at that version is rejected.
create or replace function public.vendor_quote_submit_response(p_session_digest text,p_expected_version integer,p_response jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_quote_contact_capabilities%rowtype; p public.vendor_coordination_proposals%rowtype; saved public.vendor_quote_responses%rowtype;
        q jsonb; source text; existing_response jsonb; result jsonb; v_request_version integer; working_version integer;
begin
  select cap.* into c from public.vendor_quote_contact_sessions sess join public.vendor_quote_contact_capabilities cap on cap.id=sess.capability_id
    where sess.session_digest=p_session_digest and sess.revoked_at is null and sess.expires_at>now();
  if not found or c.purpose<>'response' or c.revoked_at is not null or c.consumed_at is not null or c.expires_at<=now() then raise exception 'quote unavailable'; end if;
  perform public.lock_vendor_service(c.work_order_id);
  perform public.lock_vendor_directory(c.vendor_directory_id);
  select * into p from public.vendor_coordination_proposals where id=c.proposal_id and work_order_id=c.work_order_id and manager_user_id=c.manager_user_id and vendor_directory_id=c.vendor_directory_id for update;
  if not found or p.manager_takeover or p.accepted_bid_id is not null or p.status in ('approved','declined','cancelled') then raise exception 'stale or closed quote'; end if;
  if jsonb_typeof(p_response) is distinct from 'object' or length(coalesce(p_response->>'scope',''))>4000 or length(coalesce(p_response->>'exclusions',''))>4000 or length(coalesce(p_response->>'question',''))>2000 or jsonb_typeof(coalesce(p_response->'windows','[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(p_response->'windows','[]'::jsonb))>32 then raise exception 'invalid response'; end if;
  select vr.response into existing_response from public.vendor_quote_responses vr where vr.candidate_id=c.candidate_id and vr.request_version=p_expected_version for update;
  if found then
    if (existing_response-'followUpReply')<>p_response then raise exception 'response version reused with changed input'; end if;
    return jsonb_build_object('ok',true,'idempotent',true,'proposal',to_jsonb(p),'response',existing_response);
  end if;
  if p.version<>p_expected_version then raise exception 'stale coordination version'; end if;
  v_request_version:=p_expected_version;
  working_version:=p_expected_version;
  source:='vendor-quote:'||c.id::text||':'||p_expected_version::text;
  q:=jsonb_build_object('laborCents',case when p.visit_type='consultation' then '0'::jsonb else p_response->'laborCents' end,
    'materialsCents',case when p.visit_type='consultation' then '0'::jsonb else p_response->'materialsCents' end,
    'consultationFeeCents',p_response->'diagnosticFeeCents','scope',coalesce(p_response->'scope','""'::jsonb),
    'exclusions',coalesce(p_response->'exclusions','""'::jsonb));
  result:=public.vendor_quote_capability_action(p_session_digest,jsonb_build_object(
    'kind','replace_quote_form','expected_version',working_version,'source_message_id',source||':replacement',
    'duration_minutes',p_response->'durationMinutes','quote',q,'windows',coalesce(p_response->'windows','[]'::jsonb)));
  working_version:=working_version+1;
  if nullif(trim(p_response->>'question'),'') is not null then
    result:=public.vendor_quote_capability_action(p_session_digest,jsonb_build_object('kind','record_question','expected_version',working_version,'source_message_id',source||':question','question',coalesce(p_response->>'question','')));
  end if;
  insert into public.vendor_quote_responses(capability_id,candidate_id,proposal_id,request_version,response_version,response)
    values(c.id,c.candidate_id,c.proposal_id,v_request_version,(select version from public.vendor_coordination_proposals where id=c.proposal_id),p_response)
    returning * into saved;
  select * into p from public.vendor_coordination_proposals where id=c.proposal_id;
  return jsonb_build_object('ok',true,'idempotent',false,'proposal',to_jsonb(p),'response',saved.response);
end $$;
revoke all on function public.vendor_quote_submit_response(text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.vendor_quote_submit_response(text,integer,jsonb) to service_role;

-- Signed Twilio webhook caller supplies the canonical line and receipt id. The function binds
-- only this service candidate and the manager's directory contact; it never changes profiles.phone.
create or replace function public.consume_vendor_quote_sms_challenge(
 p_challenge_id uuid,p_code_digest text,p_from_phone text,p_to_phone text,p_messaging_service_sid text,p_inbound_event_id text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare ch public.vendor_quote_sms_consent_challenges%rowtype; c public.vendor_quote_contact_capabilities%rowtype; d public.manager_vendor_records%rowtype; v_contact jsonb; v_proposal public.vendor_coordination_proposals%rowtype; v_phone_key text; v_conversation text; v_latest_event text;
begin
 perform public.lock_vendor_service((select cap.work_order_id from public.vendor_quote_sms_consent_challenges x join public.vendor_quote_contact_capabilities cap on cap.id=x.capability_id where x.id=p_challenge_id));
 perform public.lock_vendor_directory((select vendor_directory_id from public.vendor_quote_sms_consent_challenges where id=p_challenge_id));
 select * into ch from public.vendor_quote_sms_consent_challenges where id=p_challenge_id for update;
 if not found or ch.consumed_at is not null or ch.revoked_at is not null or ch.expires_at<=now() or ch.attempts>=5 then return false; end if;
 update public.vendor_quote_sms_consent_challenges set attempts=attempts+1 where id=ch.id;
 if ch.code_digest<>p_code_digest or ch.requested_phone<>p_from_phone or ch.work_phone<>p_to_phone or ch.messaging_service_sid<>p_messaging_service_sid or ch.inbound_event_id is not null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('sms-consent-phone:'||ch.requested_phone,0));
 select * into c from public.vendor_quote_contact_capabilities where id=ch.capability_id and revoked_at is null and expires_at>now() for update;
 if not found or c.manager_user_id<>ch.manager_user_id or c.candidate_id<>ch.candidate_id or c.vendor_directory_id<>ch.vendor_directory_id or c.proposal_id<>ch.proposal_id then return false; end if;
 if c.consumed_at is not null or not public.vendor_quote_sender_is_current(c.id) then return false; end if;
 if coalesce((select i.mode from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id),'software')<>c.sender_mode or coalesce((select i.version from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id),1)<>ch.sender_version then return false; end if;
 if c.sender_mode='managed' and not exists(select 1 from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id and i.managed_work_phone=ch.work_phone and i.managed_messaging_service_sid=ch.messaging_service_sid and i.managed_email=c.sender_snapshot->>'email') then return false; end if;
 if not exists(select 1 from public.manager_sms_numbers n where n.manager_user_id=ch.manager_user_id and n.workspace_id=(c.sender_snapshot->>'workspaceId')::uuid and n.phone_number=ch.work_phone and n.messaging_service_sid=ch.messaging_service_sid and n.provision_state='active' and n.released_at is null) then return false; end if;
 if not exists(select 1 from public.vendor_sourcing_jobs j where j.id=c.job_id and j.manager_user_id=ch.manager_user_id and j.work_order_id=c.work_order_id and j.state in ('queued','sourcing','waiting','quote_collected','needs_attention')) then return false; end if;
 if not exists(select 1 from public.vendor_sourcing_candidates x where x.id=ch.candidate_id and x.job_id=c.job_id and x.manager_user_id=ch.manager_user_id and x.local_directory_id=ch.vendor_directory_id and x.proposal_id=ch.proposal_id and x.expires_at>now()) then return false; end if;
 if not exists(select 1 from public.work_order_vendor_offers o where o.work_order_id=c.work_order_id and o.manager_user_id=ch.manager_user_id and o.vendor_directory_id=ch.vendor_directory_id and o.status='sent' and o.expires_at>now()) then return false; end if;
 select * into v_proposal from public.vendor_coordination_proposals p where p.id=ch.proposal_id and p.work_order_id=c.work_order_id and p.manager_user_id=ch.manager_user_id and p.vendor_directory_id=ch.vendor_directory_id for update;
 if not found or v_proposal.version<>ch.proposal_version or v_proposal.manager_takeover or v_proposal.accepted_bid_id is not null or v_proposal.status in ('approved','declined','cancelled') then return false; end if;
 if not exists(select 1 from public.portal_work_order_records w where w.id=c.work_order_id and w.manager_user_id=ch.manager_user_id and coalesce(w.row_data->>'bucket','')='open' and nullif(w.row_data->>'vendorId','') is null and w.row_data->>'selfAssigned' is distinct from 'true') then return false; end if;
 v_phone_key:=regexp_replace(ch.requested_phone,'[^0-9]','','g');
 if length(v_phone_key)=11 and left(v_phone_key,1)='1' then v_phone_key:=substring(v_phone_key from 2); end if;
 -- Synchronize with canonical STOP/START, which upserts sms_consent(phone).
 -- Both grants and controls now contend on the same row before reading state.
 insert into public.sms_consent(phone) values(v_phone_key) on conflict(phone) do nothing;
 perform 1 from public.sms_consent where phone=v_phone_key for update;
 if exists(select 1 from public.sms_consent s where s.phone=v_phone_key and s.opted_out_at is not null and (s.opted_in_at is null or s.opted_out_at>=s.opted_in_at)) then return false; end if;
 if exists(select 1 from public.profiles p where right(regexp_replace(coalesce(p.phone,''),'[^0-9]','','g'),length(v_phone_key))=v_phone_key and p.sms_opt_out_at is not null and (p.sms_consent_at is null or p.sms_opt_out_at>=p.sms_consent_at)) then return false; end if;
 v_conversation:=ch.manager_user_id::text||':vendor:'||coalesce((select d0.vendor_user_id::text from public.manager_vendor_records d0 where d0.id=ch.vendor_directory_id),ch.requested_phone);
 select event_type into v_latest_event from public.sms_consent_events e where e.recipient_phone_key=v_phone_key and e.manager_user_id=ch.manager_user_id and e.purpose='vendor_quote_request' and e.send_class='automated' and e.messaging_service_sid=ch.messaging_service_sid and e.conversation_key=v_conversation order by e.occurred_at desc,e.created_at desc limit 1;
 if v_latest_event='revoked' then return false; end if;
 select * into d from public.manager_vendor_records where id=ch.vendor_directory_id and manager_user_id=ch.manager_user_id for update;
 if not found or (d.vendor_user_id is not null and exists(select 1 from public.profiles p where p.id=d.vendor_user_id and p.phone_verified_at is not null and p.phone is distinct from ch.requested_phone)) then return false; end if;
 if exists(select 1 from public.vendor_coordination_phone_bindings b where b.manager_user_id=ch.manager_user_id and b.vendor_directory_id=ch.vendor_directory_id and b.revoked_at is null and b.phone_e164<>ch.requested_phone) then return false; end if;
  select sc.contact into v_contact from public.vendor_sourcing_candidates sc where sc.id=ch.candidate_id and sc.job_id=c.job_id and sc.manager_user_id=c.manager_user_id for update;
 if v_contact is null then return false; end if;
 v_contact:=jsonb_set(v_contact,'{phone}',to_jsonb(ch.requested_phone),true);
 update public.vendor_sourcing_candidates sc set contact=v_contact,updated_at=now() where sc.id=ch.candidate_id;
 update public.manager_vendor_records set row_data=jsonb_set(row_data,'{phone}',to_jsonb(ch.requested_phone),true),updated_at=now() where id=ch.vendor_directory_id and manager_user_id=ch.manager_user_id;
 if not found then raise exception 'vendor identity unavailable'; end if;
 insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164,verified_at,revoked_at)
 values(ch.manager_user_id,ch.vendor_directory_id,d.vendor_user_id,ch.requested_phone,now(),null)
 on conflict(manager_user_id,vendor_directory_id) do update set vendor_user_id=excluded.vendor_user_id,phone_e164=excluded.phone_e164,verified_at=now(),revoked_at=null;
 insert into public.agent_sessions(landlord_id,user_id,kind,vendor_user_id,vendor_directory_id,work_order_id,vendor_phone_e164,status,updated_at)
 values(ch.manager_user_id,d.vendor_user_id,'vendor_work_order',d.vendor_user_id,ch.vendor_directory_id,c.work_order_id,ch.requested_phone,'active',now())
 on conflict(work_order_id,vendor_directory_id) do update set landlord_id=excluded.landlord_id,user_id=excluded.user_id,
   kind='vendor_work_order',vendor_user_id=excluded.vendor_user_id,vendor_phone_e164=excluded.vendor_phone_e164,status='active',updated_at=now();
 insert into public.vendor_quote_sms_consent_events(capability_id,challenge_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,phone_e164,work_phone,messaging_service_sid,wording_version,source_event_id)
 values(ch.capability_id,ch.id,ch.manager_user_id,ch.candidate_id,ch.vendor_directory_id,ch.proposal_id,ch.requested_phone,ch.work_phone,ch.messaging_service_sid,ch.wording_version,p_inbound_event_id);
 insert into public.sms_consent_events(recipient_phone_key,manager_user_id,messaging_service_sid,purpose,send_class,conversation_key,event_type,source,wording_version,evidence)
 values(v_phone_key,ch.manager_user_id,ch.messaging_service_sid,'vendor_quote_request','automated',v_conversation,'granted','verified_vendor_quote_inbound_challenge',ch.wording_version,jsonb_build_object('challengeId',ch.id,'candidateId',ch.candidate_id,'inboundEventId',p_inbound_event_id));
 update public.vendor_quote_sms_consent_challenges set consumed_at=now(),inbound_event_id=p_inbound_event_id where id=ch.id;
 update public.vendor_sourcing_jobs set state='queued',next_run_at=now(),lease_token=null,lease_until=null,updated_at=now() where id=c.job_id and state in ('waiting','needs_attention');
 return true;
end $$;
revoke all on function public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text) to service_role;

-- Public table retention is intentional: capability, delivery, permission and consent evidence
-- are minimal auditable contact records and cascade from the owning account/service where safe.
