-- Recovery never replays vendor authority or automation; canonical business records keep history.
-- Every owned root and destructive child participates in the existing recovery lifecycle.
do $vendor_recovery_guards$
declare
  table_name text;
  target_table oid;
  write_guard_function oid;
  capture_delete_function oid;
  existing_trigger record;
begin
  select p.oid into write_guard_function from pg_proc p
    where p.oid=to_regprocedure('public.account_recovery_write_guard()')
      and p.prorettype='pg_catalog.trigger'::regtype;
  select p.oid into capture_delete_function from pg_proc p
    where p.oid=to_regprocedure('public.account_recovery_capture_delete()')
      and p.prorettype='pg_catalog.trigger'::regtype;
  if write_guard_function is null or capture_delete_function is null then
    raise exception 'vendor recovery guard prerequisites are missing';
  end if;
  foreach table_name in array array['vendor_outreach_workspace_profiles','vendor_quote_contact_capabilities','vendor_quote_email_outbox','vendor_quote_email_permissions','vendor_quote_sms_consent_events','vendor_quote_sms_consent_challenges','vendor_sourcing_candidates','vendor_sourcing_jobs','vendor_coordination_phone_challenges','vendor_coordination_phone_bindings','vendor_coordination_reservations','vendor_coordination_proposals','vendor_quote_contact_sessions','vendor_quote_email_delivery_events','vendor_quote_responses','vendor_coordination_operations'] loop
    select c.oid into target_table from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=table_name and c.relkind in ('r','p');
    if target_table is null then raise exception 'vendor recovery table missing: %',table_name; end if;
    select * into existing_trigger from pg_trigger
      where tgrelid=target_table and tgname='account_recovery_write_guard';
    if found then
      if existing_trigger.tgisinternal or existing_trigger.tgfoid<>write_guard_function
        or existing_trigger.tgtype<>31 or existing_trigger.tgattr::text<>''
        or existing_trigger.tgenabled<>'O' or existing_trigger.tgnargs<>0
        or existing_trigger.tgqual is not null or existing_trigger.tgconstraint<>0 then
        raise exception '% account_recovery_write_guard conflicts with the required recovery trigger',table_name;
      end if;
    else
      execute format('create trigger account_recovery_write_guard before insert or update or delete on public.%I for each row execute function public.account_recovery_write_guard()',table_name);
    end if;
    select * into existing_trigger from pg_trigger
      where tgrelid=target_table and tgname='account_recovery_capture_delete';
    if found then
      if existing_trigger.tgisinternal or existing_trigger.tgfoid<>capture_delete_function
        or existing_trigger.tgtype<>9 or existing_trigger.tgattr::text<>''
        or existing_trigger.tgenabled<>'O' or existing_trigger.tgnargs<>0
        or existing_trigger.tgqual is not null or existing_trigger.tgconstraint<>0 then
        raise exception '% account_recovery_capture_delete conflicts with the required recovery trigger',table_name;
      end if;
    else
      execute format('create trigger account_recovery_capture_delete after delete on public.%I for each row execute function public.account_recovery_capture_delete()',table_name);
    end if;
  end loop;
end
$vendor_recovery_guards$;

-- Recovery may reinsert a service while automation is enabled. Only an explicit
-- later Start action may enqueue its fresh, empty job.
create or replace function public.enqueue_vendor_sourcing() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.manager_user_id is not null and nullif(new.resident_email,'') is not null and coalesce(new.row_data->>'managerInitiated','false') <> 'true' then
  insert into public.vendor_sourcing_jobs(work_order_id,manager_user_id,state)
   values(new.id,new.manager_user_id,case
    when current_setting('proplane.account_recovery_internal',true)='on' then 'dormant'
    when exists(select 1 from public.manager_automation_settings s where s.manager_user_id=new.manager_user_id and s.vendor_dispatch->>'quoteSourcingEnabled'='true') then 'queued'
    else 'dormant' end)
   on conflict(work_order_id) do nothing;
 end if; return new;
end $$;
revoke all on function public.enqueue_vendor_sourcing() from public,anon,authenticated;

-- Appointment collision evidence stays on the manager-private directory record.
-- It is never an authentication/consent source or a public service payload field.
create or replace function public.guard_vendor_coordination_appointment_evidence() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if current_setting('proplane.vendor_coordination_write',true)='on'
   or current_setting('proplane.account_recovery_internal',true)='on' then return new; end if;
 if TG_OP='INSERT' then
  if new.row_data ? 'vendorCoordinationAppointmentEvidence' then raise exception 'appointment evidence is server-owned'; end if;
 elsif new.row_data->'vendorCoordinationAppointmentEvidence' is distinct from old.row_data->'vendorCoordinationAppointmentEvidence' then
  if not (new.row_data ? 'vendorCoordinationAppointmentEvidence') then
   if old.row_data ? 'vendorCoordinationAppointmentEvidence' then
    new.row_data:=new.row_data||jsonb_build_object('vendorCoordinationAppointmentEvidence',old.row_data->'vendorCoordinationAppointmentEvidence');
   end if;
  else raise exception 'appointment evidence is server-owned'; end if;
 end if;
 return new;
end $$;
revoke all on function public.guard_vendor_coordination_appointment_evidence() from public,anon,authenticated,service_role;
do $vendor_appointment_evidence_guard$
declare t record;
begin
 select * into t from pg_trigger where tgrelid='public.manager_vendor_records'::regclass and tgname='guard_vendor_coordination_appointment_evidence';
 if found then
  if t.tgisinternal or t.tgfoid<>'public.guard_vendor_coordination_appointment_evidence()'::regprocedure
   or t.tgtype<>23 or t.tgattr::text<>'' or t.tgenabled<>'O' or t.tgnargs<>0 or t.tgqual is not null or t.tgconstraint<>0 then
   raise exception 'directory appointment evidence trigger conflicts';
  end if;
 else
  create trigger guard_vendor_coordination_appointment_evidence before insert or update on public.manager_vendor_records
   for each row execute function public.guard_vendor_coordination_appointment_evidence();
 end if;
end
$vendor_appointment_evidence_guard$;

create or replace function public.vendor_coordination_canonical_visits(
 p_vendor_user uuid,p_phone text,p_exclude_service text default null
) returns table(starts_at timestamptz,ends_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
 select slot.at::timestamptz,slot.at::timestamptz+make_interval(mins=>slot.minutes)
 from public.portal_work_order_records w
 left join public.manager_vendor_records repair on repair.id=w.row_data->>'vendorId' and repair.manager_user_id=w.manager_user_id
 left join public.vendor_coordination_phone_bindings binding on binding.vendor_directory_id=repair.id and binding.manager_user_id=w.manager_user_id and binding.revoked_at is null
 left join public.manager_vendor_records consultation on consultation.id=w.row_data->>'consultationVendorDirectoryId' and consultation.manager_user_id=w.manager_user_id
 cross join lateral (values
  (nullif(w.row_data->>'scheduledAtIso',''),coalesce(nullif(w.row_data->>'visitDurationMinutes','')::integer,60),
    (p_vendor_user is not null and (w.vendor_user_id=p_vendor_user or repair.vendor_user_id=p_vendor_user))
    or (p_phone is not null and binding.phone_e164=p_phone),
    w.row_data->>'coordinationProposalId',repair.row_data->'vendorCoordinationAppointmentEvidence'->(w.id||':repair')),
  (nullif(w.row_data->>'consultationVisitAt',''),coalesce(nullif(w.row_data->>'consultationDurationMinutes','')::integer,60),
    p_vendor_user is not null and consultation.vendor_user_id=p_vendor_user,
    w.row_data->>'consultationCoordinationProposalId',consultation.row_data->'vendorCoordinationAppointmentEvidence'->(w.id||':consultation'))
 ) slot(at,minutes,same_participant,proposal_id,evidence)
 where w.id is distinct from p_exclude_service and coalesce(w.row_data->>'bucket','') not in ('completed','cancelled')
   and slot.at is not null and (slot.same_participant or
    (p_phone is not null and slot.evidence->>'phoneE164'=p_phone
     and slot.evidence->>'proposalId'=slot.proposal_id and slot.evidence->>'startsAt'=slot.at
     and slot.evidence->>'durationMinutes'=slot.minutes::text))
$$;
revoke all on function public.vendor_coordination_canonical_visits(uuid,text,text) from public,anon,authenticated,service_role;

-- The sole surviving-proposal exception is publication of this exact vendor-owned
-- archived accepted bid, under the existing verified recovery claim and service lock.
create or replace function public.vendor_coordination_recovered_bid_proposal(p_bid public.work_order_bids)
returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
declare proposal_id uuid;
begin
 if current_setting('proplane.account_recovery_internal',true) is distinct from 'on'
   or p_bid.status is distinct from 'accepted' or p_bid.vendor_user_id is null then return null; end if;
 if not exists(select 1 from public.account_recovery_records r
   join public.account_recovery_holds h on h.record_id=r.id
   join public.account_recovery_requests a on a.id=h.request_id
   where r.table_name='work_order_bids' and r.row_key=jsonb_build_object('id',p_bid.id)
     and r.archived and not r.erased and r.recoverable and r.payload=to_jsonb(p_bid)
     and h.kind='delete' and h.decision='recover' and a.portal='vendor'
     and a.user_id=p_bid.vendor_user_id and a.state='recovering' and a.decision='recover'
     and a.claim_id is not null and public.account_recovery_publishable(r.id)) then return null; end if;
 select p.id into proposal_id from public.vendor_coordination_proposals p
  join public.portal_work_order_records w on w.id=p.work_order_id and w.manager_user_id=p.manager_user_id
  join public.manager_vendor_records d on d.id=p.vendor_directory_id and d.manager_user_id=p.manager_user_id
  where p.work_order_id=p_bid.work_order_id and p.manager_user_id=p_bid.manager_user_id
    and p.vendor_directory_id=p_bid.vendor_directory_id and d.vendor_user_id=p_bid.vendor_user_id
    and w.vendor_user_id=p_bid.vendor_user_id and p.visit_type='repair' and p.status='approved'
    and (p.accepted_bid_id is null or p.accepted_bid_id=p_bid.id)
    and p.labor_cents=p_bid.amount_cents and p.materials_cents=p_bid.materials_cents
    and p.scope is not distinct from p_bid.note and p.selected_start_at=p_bid.proposed_time
    and w.row_data->>'coordinationProposalId'=p.id::text and w.row_data->>'vendorId'=p.vendor_directory_id
    and w.row_data->>'bucket'='scheduled'
    and w.row_data->>'scheduledAtIso'=to_char(p.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
    and w.row_data->>'visitDurationMinutes'=p.duration_minutes::text
    and w.row_data->>'vendorCostCents'=p_bid.amount_cents::text
    and w.row_data->>'materialsCostCents'=p_bid.materials_cents::text
    and w.row_data->>'quoteScope' is not distinct from p.scope
    and w.row_data->>'quoteExclusions' is not distinct from p.exclusions;
 if proposal_id is null or exists(select 1 from public.work_order_bids b where b.work_order_id=p_bid.work_order_id and b.status='accepted' and b.id<>p_bid.id)
   or exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=p_bid.work_order_id and p.status in ('collecting','ready','approved') and p.id<>proposal_id) then return null; end if;
 return proposal_id;
end $$;
revoke all on function public.vendor_coordination_recovered_bid_proposal(public.work_order_bids) from public,anon,authenticated,service_role;

-- Patch only recognized existing bodies, preserving current release authority and lock order.
do $vendor_recovery_compat$
declare definition text; before_fragment text; after_fragment text; patch record; matches integer; applied_matches integer; contained_matches integer;
begin
 for patch in select * from (values
  ('public.guard_legacy_vendor_bid_coordination()',
   $before$   raise exception using errcode='40001',message='approve the current coordinated visit proposal';$before$,
   $after$   if tg_op='INSERT' and public.vendor_coordination_recovered_bid_proposal(new) is not null then return new; end if;
   raise exception using errcode='40001',message='approve the current coordinated visit proposal';$after$),
  ('public.wake_vendor_sourcing_quote()',
   $before$ -- Identity attachment and bookkeeping metadata cannot wake a sourcing job.$before$,
   $after$ -- Relinking an exact published accepted bid restores no automation or delivery intent.
 if current_setting('proplane.account_recovery_internal',true)='on'
   and old.accepted_bid_id is null and new.accepted_bid_id is not null
   and (to_jsonb(new)-'accepted_bid_id')=(to_jsonb(old)-'accepted_bid_id')
   and public.vendor_coordination_recovered_bid_proposal((select b from public.work_order_bids b where b.id=new.accepted_bid_id))=new.id then return new; end if;
 -- Identity attachment and bookkeeping metadata cannot wake a sourcing job.$after$),
  ('public.account_recovery_recreatable(text)',
   $before$select p_table=any(array[$before$,
   $after$select p_table='vendor_outreach_workspace_profiles' or p_table=any(array[$after$),
  ('public.account_recovery_restore_reference(uuid,uuid)',
   $before$  if current_data is null or not (current_data @> (h.identity_patch->'after'))$before$,
   $after$  -- A surviving manager's operational record may regain only its current directory participant.
  if h.kind='reference' and r.table_name in ('vendor_coordination_proposals','vendor_coordination_reservations')
    and not exists(select 1 from public.manager_vendor_records directory
      where directory.id=current_data->>'vendor_directory_id'
        and directory.manager_user_id::text=current_data->>'manager_user_id'
        and directory.vendor_user_id=a.user_id) then
    update public.account_recovery_holds set identity_patch=null where request_id=a.id and record_id=r.id;
    return;
  end if;
  if current_data is null or not (current_data @> (h.identity_patch->'after'))$after$),
  ('public.vendor_coordination_action(jsonb)',
   $before$    if v_proposal.visit_type = 'repair' then
      v_total := v_proposal.labor_cents + v_proposal.materials_cents;$before$,
   $after$    update public.manager_vendor_records set row_data=row_data||jsonb_build_object(
      'vendorCoordinationAppointmentEvidence',coalesce(row_data->'vendorCoordinationAppointmentEvidence','{}'::jsonb)||
      jsonb_build_object(v_work.id||':'||v_proposal.visit_type,jsonb_build_object(
       'proposalId',v_proposal.id::text,'startsAt',to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       'durationMinutes',v_proposal.duration_minutes,'phoneE164',v_verified_phone)))
      where id=v_directory.id and manager_user_id=v_proposal.manager_user_id;
    if v_proposal.visit_type = 'repair' then
      v_total := v_proposal.labor_cents + v_proposal.materials_cents;$after$),
  ('public.vendor_coordination_action(jsonb)',
   $before$    perform public.lock_vendor_directory(v_directory_id);
  end if;
  perform public.lock_vendor_service$before$,
   $after$    perform public.lock_vendor_directory(v_directory_id);
  elsif v_kind='approve_manager' then
    select vendor_directory_id into v_directory_id from public.vendor_coordination_proposals where id=nullif(p_action->>'proposal_id','')::uuid;
    if v_directory_id is null then raise exception 'coordination proposal missing'; end if;
    perform public.lock_vendor_directory(v_directory_id);
  end if;
  perform public.lock_vendor_service$after$),
  ('public.vendor_coordination_action(jsonb)',
   $before$'consultationCoordinationProposalId',v_proposal.id::text), updated_at = now()$before$,
   $after$'consultationCoordinationProposalId',v_proposal.id::text,
        'consultationVendorDirectoryId',v_proposal.vendor_directory_id), updated_at = now()$after$),
  ('public.vendor_coordination_action(jsonb)',
   $before$row_data - 'consultationVisitAt' - 'consultationDurationMinutes', updated_at$before$,
   $after$row_data - 'consultationVisitAt' - 'consultationDurationMinutes' - 'consultationVendorDirectoryId', updated_at$after$),
  ('public.guard_enrolled_vendor_coordination_work_order()',
   $before$if current_setting('proplane.vendor_coordination_write', true) = 'on' then return new; end if;$before$,
   $after$if current_setting('proplane.vendor_coordination_write', true) = 'on'
    or current_setting('proplane.account_recovery_internal',true)='on' then return new; end if;$after$),
  ('public.guard_enrolled_vendor_coordination_work_order()',
   $before$'materialsCostCents','cost','biddingOpen','visitDurationMinutes','consultationFeeCents']$before$,
   $after$'materialsCostCents','cost','biddingOpen','visitDurationMinutes','consultationFeeCents',
    'consultationVendorDirectoryId']$after$),
  ('public.vendor_coordination_action(jsonb)',
   $before$    if exists (select 1 from public.portal_work_order_records legacy
      left join public.manager_vendor_records linked on linked.id = legacy.row_data->>'vendorId'
      left join public.vendor_coordination_phone_bindings lb on lb.vendor_directory_id = linked.id and lb.revoked_at is null
      where legacy.id <> v_work.id and coalesce(legacy.row_data->>'bucket','') not in ('completed','cancelled')
        and legacy.row_data->>'scheduledAtIso' is not null
        and (lb.phone_e164 = v_verified_phone or
          (v_identity_user is not null and (legacy.vendor_user_id = v_identity_user or linked.vendor_user_id = v_identity_user)))
        and (legacy.row_data->>'scheduledAtIso')::timestamptz < v_end
        and (legacy.row_data->>'scheduledAtIso')::timestamptz +
          make_interval(mins => coalesce(nullif(legacy.row_data->>'visitDurationMinutes','')::integer,60)) > v_start) then$before$,
   $after$    if exists (select 1 from public.vendor_coordination_canonical_visits(v_identity_user,v_verified_phone,v_work.id) visit
      where visit.starts_at<v_end and visit.ends_at>v_start) then$after$),
  ('public.guard_vendor_calendar_against_coordination()',
   $before$  return new;
end$before$,
   $after$  -- Existing user lock also serializes canonical appointments whose operational rows were erased.
  if exists(select 1 from public.vendor_coordination_canonical_visits(new.vendor_user_id,
      (select profile.phone from public.profiles profile where profile.id=new.vendor_user_id and profile.phone_verified_at is not null),null) visit
    where public.vendor_coordination_busy_rule_overlaps(new,visit.starts_at,visit.ends_at)) then
    raise exception 'vendor calendar block conflicts with canonical booked visit';
  end if;
  return new;
end$after$)
 ) fragments(signature,before_fragment,after_fragment) loop
  if to_regprocedure(patch.signature) is null then raise exception 'vendor recovery compatibility prerequisite missing: %',patch.signature; end if;
  definition:=pg_get_functiondef(to_regprocedure(patch.signature));
  before_fragment:=patch.before_fragment;after_fragment:=patch.after_fragment;
  matches:=(length(definition)-length(replace(definition,before_fragment,'')))/length(before_fragment);
  applied_matches:=(length(definition)-length(replace(definition,after_fragment,'')))/length(after_fragment);
  contained_matches:=(length(after_fragment)-length(replace(after_fragment,before_fragment,'')))/length(before_fragment);
  if applied_matches=1 and matches=contained_matches then null;
  elsif applied_matches=0 and matches=1 then execute replace(definition,before_fragment,after_fragment);
  else raise exception 'unrecognized vendor recovery compatibility body: %',patch.signature;
  end if;
 end loop;
end
$vendor_recovery_compat$;

-- Backfill only an exactly matching approved appointment and its active reservation.
-- No participant is inferred from mutable contact text or from a default account.
do $vendor_recovery_participants$
declare appointment record; matches integer; participant record; previous_write text:=current_setting('proplane.vendor_coordination_write',true);
begin
 perform set_config('proplane.vendor_coordination_write','on',true);
 if exists(select 1 from public.portal_work_order_records w
  cross join lateral (values
   ('repair',nullif(w.row_data->>'scheduledAtIso',''),w.row_data->>'coordinationProposalId',w.row_data->>'vendorId',w.row_data->>'visitDurationMinutes'),
   ('consultation',nullif(w.row_data->>'consultationVisitAt',''),w.row_data->>'consultationCoordinationProposalId',w.row_data->>'consultationVendorDirectoryId',w.row_data->>'consultationDurationMinutes')
  ) slot(kind,at,proposal_id,directory_id,minutes)
  where coalesce(w.row_data->>'bucket','') not in ('completed','cancelled') and slot.at is not null
   and (slot.kind='consultation' or slot.proposal_id is not null)
   and not exists(select 1 from public.vendor_coordination_proposals p
    join public.vendor_coordination_reservations r on r.proposal_id=p.id
    where p.id::text=slot.proposal_id and p.work_order_id=w.id and p.manager_user_id=w.manager_user_id
     and p.visit_type=slot.kind and p.status='approved'
     and to_char(p.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')=slot.at and p.duration_minutes::text=slot.minutes
     and (slot.directory_id is null and slot.kind='consultation' or p.vendor_directory_id=slot.directory_id)
     and r.work_order_id=w.id and r.manager_user_id=w.manager_user_id and r.vendor_directory_id=p.vendor_directory_id
     and r.status='active' and r.starts_at=p.selected_start_at and r.ends_at=p.selected_start_at+make_interval(mins=>p.duration_minutes)
     and r.vendor_phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
   and not exists(select 1 from public.manager_vendor_records d
    cross join lateral (select d.row_data->'vendorCoordinationAppointmentEvidence'->(w.id||':'||slot.kind) value) evidence
    where d.id=slot.directory_id and d.manager_user_id=w.manager_user_id
     and evidence.value->>'proposalId'=slot.proposal_id and evidence.value->>'startsAt'=slot.at
     and evidence.value->>'durationMinutes'=slot.minutes and evidence.value->>'phoneE164' ~ '^\+[1-9][0-9]{7,14}$')) then
  raise exception 'active vendor appointment has unprovable canonical participant';
 end if;
 for appointment in
  select w.id,w.manager_user_id,p.id proposal_id,p.visit_type,p.vendor_directory_id,p.selected_start_at,p.duration_minutes
  from public.portal_work_order_records w join public.vendor_coordination_proposals p
    on p.work_order_id=w.id and p.manager_user_id=w.manager_user_id and p.status='approved'
  where (p.visit_type='repair' and w.row_data->>'coordinationProposalId'=p.id::text
      and w.row_data->>'scheduledAtIso'=to_char(p.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      and w.row_data->>'vendorId'=p.vendor_directory_id)
    or (p.visit_type='consultation' and w.row_data->>'consultationCoordinationProposalId'=p.id::text
      and w.row_data->>'consultationVisitAt'=to_char(p.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
 loop
  select count(*) into matches from public.vendor_coordination_reservations r
   where r.proposal_id=appointment.proposal_id and r.work_order_id=appointment.id
     and r.manager_user_id=appointment.manager_user_id and r.vendor_directory_id=appointment.vendor_directory_id
     and r.status='active' and r.starts_at=appointment.selected_start_at
     and r.ends_at=appointment.selected_start_at+make_interval(mins=>appointment.duration_minutes)
     and r.vendor_phone_e164 ~ '^\+[1-9][0-9]{7,14}$';
  if matches<>1 then raise exception 'approved vendor appointment lacks one exact active participant: %',appointment.id; end if;
  select r.vendor_phone_e164 into participant from public.vendor_coordination_reservations r where r.proposal_id=appointment.proposal_id;
  perform public.lock_vendor_directory(appointment.vendor_directory_id);
  perform public.lock_vendor_service(appointment.id);
  update public.manager_vendor_records set row_data=row_data||jsonb_build_object(
    'vendorCoordinationAppointmentEvidence',coalesce(row_data->'vendorCoordinationAppointmentEvidence','{}'::jsonb)||
    jsonb_build_object(appointment.id||':'||appointment.visit_type,jsonb_build_object(
      'proposalId',appointment.proposal_id::text,'startsAt',to_char(appointment.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'durationMinutes',appointment.duration_minutes,'phoneE164',participant.vendor_phone_e164)))
    where id=appointment.vendor_directory_id and manager_user_id=appointment.manager_user_id;
  if appointment.visit_type='consultation' then
   update public.portal_work_order_records set row_data=row_data||jsonb_build_object('consultationVendorDirectoryId',appointment.vendor_directory_id)
    where id=appointment.id;
  end if;
 end loop;
 perform set_config('proplane.vendor_coordination_write',coalesce(previous_write,''),true);
end
$vendor_recovery_participants$;

create or replace function public.reattach_vendor_recovered_accepted_bid() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare proposal_id uuid;
begin
 proposal_id:=public.vendor_coordination_recovered_bid_proposal(new);
 if proposal_id is not null then
  update public.vendor_coordination_proposals set accepted_bid_id=new.id where id=proposal_id and accepted_bid_id is null;
 end if;
 return new;
end $$;
revoke all on function public.reattach_vendor_recovered_accepted_bid() from public,anon,authenticated,service_role;
do $vendor_recovered_bid_link$
declare t record;
begin
 select * into t from pg_trigger where tgrelid='public.work_order_bids'::regclass and tgname='reattach_vendor_recovered_accepted_bid';
 if found then
  if t.tgisinternal or t.tgfoid<>'public.reattach_vendor_recovered_accepted_bid()'::regprocedure
    or t.tgtype<>5 or t.tgattr::text<>'' or t.tgenabled<>'O' or t.tgnargs<>0 or t.tgqual is not null or t.tgconstraint<>0 then
   raise exception 'recovered accepted bid trigger conflicts';
  end if;
 else
  create trigger reattach_vendor_recovered_accepted_bid after insert on public.work_order_bids
   for each row execute function public.reattach_vendor_recovered_accepted_bid();
 end if;
end
$vendor_recovered_bid_link$;
