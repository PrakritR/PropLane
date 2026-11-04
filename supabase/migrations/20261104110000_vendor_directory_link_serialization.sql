-- Account attachment and enrollment share a directory fence before any service
-- boundary. The existing per-service lock remains the ordering boundary for
-- cancellation, offer lifecycle, quote changes, and booking.
create or replace function public.lock_vendor_directory(p_directory_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if nullif(trim(p_directory_id),'') is null then
    raise exception 'vendor directory id required';
  end if;
  perform pg_advisory_xact_lock(161501,hashtext(p_directory_id));
end $$;
revoke all on function public.lock_vendor_directory(text) from public,anon,authenticated;
grant execute on function public.lock_vendor_directory(text) to service_role;

-- Enumerate every service whose rows the legacy directory trigger can touch,
-- plus offers. Sort by the actual signed advisory key, rather than text id;
-- hash collisions share one lock acquisition.
create or replace function public.lock_vendor_directory_services(
  p_directory_id text,p_manager_user_id uuid,p_try boolean
) returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_service record;
begin
  for v_service in
    select min(affected.work_order_id) as work_order_id,
      hashtext(affected.work_order_id) as lock_key
    from (
      select work_order_id from public.vendor_coordination_proposals
        where vendor_directory_id=p_directory_id and manager_user_id=p_manager_user_id
      union
      select work_order_id from public.vendor_coordination_reservations
        where vendor_directory_id=p_directory_id and manager_user_id=p_manager_user_id
      union
      select work_order_id from public.work_order_vendor_offers
        where vendor_directory_id=p_directory_id and manager_user_id=p_manager_user_id
      union
      select work_order_id from public.work_order_bids
        where vendor_directory_id=p_directory_id and manager_user_id=p_manager_user_id
      union
      select id as work_order_id from public.portal_work_order_records
        where manager_user_id=p_manager_user_id and row_data->>'vendorId'=p_directory_id
    ) affected
    group by hashtext(affected.work_order_id)
    order by lock_key
  loop
    if p_try then
      if not pg_try_advisory_xact_lock(161500,v_service.lock_key) then
        raise exception using errcode='40001',message='vendor directory identity needs service retry';
      end if;
    else
      perform pg_advisory_xact_lock(161500,v_service.lock_key);
    end if;
  end loop;
end $$;
revoke all on function public.lock_vendor_directory_services(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.lock_vendor_directory_services(text,uuid,boolean) to service_role;

-- The caller has already proved possession of the invited email. This RPC is
-- the authoritative owner/identity check and makes directory + offer attachment
-- one transaction. A conflicting participant cannot be silently replaced.
create or replace function public.link_vendor_directory_account(
  p_directory_id text,p_manager_user_id uuid,p_vendor_user_id uuid
) returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_directory public.manager_vendor_records%rowtype;
begin
  if nullif(trim(p_directory_id),'') is null or p_manager_user_id is null or p_vendor_user_id is null then
    raise exception 'vendor directory link arguments required';
  end if;
  perform public.lock_vendor_directory(p_directory_id);
  select * into v_directory from public.manager_vendor_records where id=p_directory_id;
  if not found or v_directory.manager_user_id is distinct from p_manager_user_id then
    raise exception 'vendor directory owner mismatch';
  end if;
  if v_directory.vendor_user_id is not null and v_directory.vendor_user_id is distinct from p_vendor_user_id then
    raise exception 'vendor directory already linked to another account';
  end if;
  perform public.lock_vendor_directory_services(p_directory_id,p_manager_user_id,false);
  select * into v_directory from public.manager_vendor_records where id=p_directory_id for update;
  if not found or v_directory.manager_user_id is distinct from p_manager_user_id then
    raise exception 'vendor directory owner mismatch';
  end if;
  if v_directory.vendor_user_id is not null and v_directory.vendor_user_id is distinct from p_vendor_user_id then
    raise exception 'vendor directory already linked to another account';
  end if;
  if v_directory.vendor_user_id is null then
    update public.manager_vendor_records set vendor_user_id=p_vendor_user_id,updated_at=now()
      where id=p_directory_id;
  end if;
  update public.work_order_vendor_offers set vendor_user_id=p_vendor_user_id,updated_at=now()
    where vendor_directory_id=p_directory_id and manager_user_id=p_manager_user_id and vendor_user_id is null;
  return true;
end $$;
revoke all on function public.link_vendor_directory_account(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.link_vendor_directory_account(text,uuid,uuid) to service_role;

-- A direct directory update already owns its tuple. Never wait for a service
-- boundary inside this AFTER trigger: unsupported ordering fails for retry
-- before touching a dependent row. The RPC reenters locks it already owns.
create or replace function public.invalidate_directory_vendor_coordination_phone_binding()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.vendor_user_id is distinct from old.vendor_user_id then
    if not pg_try_advisory_xact_lock(161501,hashtext(new.id)) then
      raise exception using errcode='40001',message='vendor directory identity needs directory retry';
    end if;
    perform public.lock_vendor_directory_services(new.id,new.manager_user_id,true);
  end if;
  if new.row_data->>'phone' is distinct from old.row_data->>'phone' then
    update public.vendor_coordination_phone_bindings set revoked_at = now()
      where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and revoked_at is null;
  end if;
  if new.vendor_user_id is distinct from old.vendor_user_id then
    if old.vendor_user_id is null and new.vendor_user_id is not null then
      update public.vendor_coordination_phone_bindings set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      -- A directory may have been unlinked before this attachment. Existing
      -- bookings retain their participant, just like accepted bids below.
      update public.vendor_coordination_reservations set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      update public.vendor_coordination_proposals set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      update public.work_order_bids set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      update public.portal_work_order_records set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_user_id is null
          and row_data->>'vendorId' = new.id;
    else
      -- Reassignment is a different participant; old bookings retain their historical account.
      update public.vendor_coordination_phone_bindings set revoked_at = now()
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and revoked_at is null;
    end if;
  end if;
  return new;
end $$;


-- Enrollment takes the directory fence before the preexisting service boundary.
create or replace function public.vendor_coordination_action(p_action jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind text := p_action->>'kind';
  v_proposal public.vendor_coordination_proposals%rowtype;
  v_work public.portal_work_order_records%rowtype;
  v_directory public.manager_vendor_records%rowtype;
  v_binding public.vendor_coordination_phone_bindings%rowtype;
  v_actor uuid := nullif(p_action->>'actor_user_id','')::uuid;
  v_directory_id text;
  v_visit_type text;
  v_version integer;
  v_windows jsonb;
  v_window jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_duration integer;
  v_total integer;
  v_quote jsonb;
  v_bid public.work_order_bids%rowtype;
  v_event_id uuid;
  v_identity_user uuid;
  v_verified_phone text;
  v_sender_email text;
  v_source text := nullif(left(trim(p_action->>'source_message_id'),200),'');
  v_input_hash text := md5((p_action - 'expected_version')::text);
  v_existing_hash text;
begin
  if v_kind = 'enroll' then
    v_directory_id := nullif(trim(p_action->>'vendor_directory_id'),'');
    if v_directory_id is null then raise exception 'invalid enrollment'; end if;
    perform public.lock_vendor_directory(v_directory_id);
  end if;
  perform public.lock_vendor_service(case when v_kind='enroll' then p_action->>'work_order_id' else (select work_order_id from public.vendor_coordination_proposals where id=nullif(p_action->>'proposal_id','')::uuid) end);
  if v_kind = 'enroll' then
    v_directory_id := nullif(trim(p_action->>'vendor_directory_id'),'');
    v_visit_type := p_action->>'visit_type';
    if v_visit_type is null or v_visit_type not in ('consultation','repair')
      or v_directory_id is null or v_actor is null then
      raise exception 'invalid enrollment';
    end if;
    select * into v_work from public.portal_work_order_records where id = p_action->>'work_order_id' for update;
    if not found or v_work.manager_user_id is distinct from nullif(p_action->>'manager_user_id','')::uuid
      or v_actor is distinct from v_work.manager_user_id then raise exception 'work order owner mismatch'; end if;
    select * into v_directory from public.manager_vendor_records where id = v_directory_id;
    if not found or v_directory.manager_user_id is distinct from v_work.manager_user_id then
      raise exception 'vendor directory owner mismatch'; end if;
    if not exists (select 1 from public.work_order_vendor_offers o where o.work_order_id = v_work.id
      and o.manager_user_id = v_work.manager_user_id and o.vendor_directory_id = v_directory.id
      and o.status = 'sent' and o.expires_at > now())
      and v_work.row_data->>'vendorId' is distinct from v_directory.id then
      raise exception 'vendor has no active offer or assignment'; end if;
    insert into public.vendor_coordination_proposals
      (work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,source_message_ids)
    values(v_work.id,v_work.manager_user_id,v_directory.id,v_directory.vendor_user_id,v_visit_type,
      case when v_source is null then '[]'::jsonb else jsonb_build_array(v_source) end)
    on conflict(work_order_id,vendor_directory_id,visit_type) do nothing;
    select * into v_proposal from public.vendor_coordination_proposals
      where work_order_id = v_work.id and vendor_directory_id = v_directory.id and visit_type = v_visit_type;
    if v_source is not null then
      select input_hash into v_existing_hash from public.vendor_coordination_operations
        where proposal_id = v_proposal.id and source_message_id = v_source and action_kind = v_kind;
      if found then
        if v_existing_hash <> v_input_hash then raise exception 'message action reused with changed input'; end if;
        return to_jsonb(v_proposal);
      end if;
    end if;
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':enrolled','work_order',
      'coordination_updated','maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'version',v_proposal.version,
        'propertyId',v_work.property_id,'action','enroll'))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        status,next_attempt_at,rendered)
      values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object('subject','Service coordination started',
          'text','A ' || v_proposal.visit_type || ' visit proposal was opened.'));
      if v_directory.vendor_user_id is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
          recipient_email,status,next_attempt_at,rendered)
        values(v_event_id,'vendor',coalesce(v_directory.vendor_user_id::text,lower(trim(v_directory.row_data->>'email'))),
          v_directory.vendor_user_id,nullif(lower(trim(v_directory.row_data->>'email')),''),
          'pending',now(),jsonb_build_object('subject','Service visit proposal',
            'text','Please send your ' || v_proposal.visit_type || ' quote, duration and available windows to the manager. No visit is booked yet.'));
      end if;
      if nullif(trim(v_work.resident_email),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
          status,next_attempt_at,rendered)
        values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
          'pending',now(),jsonb_build_object('subject','Choose windows for a service visit',
            'text','Please submit available windows for a ' || v_proposal.visit_type || ' visit in Resident Services. No appointment is booked yet.'));
      end if;
    end if;
    if v_source is not null then
      insert into public.vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash)
        values(v_proposal.id,v_source,v_kind,v_input_hash);
    end if;
    return to_jsonb(v_proposal);
  end if;

  select * into v_proposal from public.vendor_coordination_proposals
    where id = nullif(p_action->>'proposal_id','')::uuid for update;
  if not found then raise exception 'coordination proposal missing'; end if;
  select * into v_work from public.portal_work_order_records where id = v_proposal.work_order_id for update;
  select * into v_directory from public.manager_vendor_records where id = v_proposal.vendor_directory_id;
  if v_work.id is null or v_directory.id is null or v_work.manager_user_id is distinct from v_proposal.manager_user_id
    or v_directory.manager_user_id is distinct from v_proposal.manager_user_id then
    raise exception 'coordination owner changed'; end if;
  if not exists (select 1 from public.work_order_vendor_offers o where o.work_order_id = v_work.id
      and o.manager_user_id = v_work.manager_user_id and o.vendor_directory_id = v_directory.id
      and o.status = 'sent' and o.expires_at > now())
      and v_work.row_data->>'vendorId' is distinct from v_directory.id then
    raise exception 'vendor offer or assignment inactive'; end if;
  -- Keep the stable directory participant and attach a later account without rewriting history.
  v_identity_user := v_directory.vendor_user_id;
  update public.vendor_coordination_proposals set vendor_user_id = v_identity_user
    where id = v_proposal.id and vendor_user_id is distinct from v_identity_user;
  select * into v_binding from public.vendor_coordination_phone_bindings
    where manager_user_id = v_proposal.manager_user_id and vendor_directory_id = v_proposal.vendor_directory_id
      and revoked_at is null;
  v_verified_phone := v_binding.phone_e164;
  if v_verified_phone is null and v_identity_user is not null then
    select phone into v_verified_phone from public.profiles
      where id = v_identity_user and phone_verified_at is not null and phone ~ '^\+[1-9][0-9]{7,14}$';
  end if;
  if v_kind in ('revise_quote','submit_vendor_windows','confirm_vendor') then
    if p_action->>'vendor_directory_id' is distinct from v_proposal.vendor_directory_id
      or ((v_identity_user is null or v_actor is distinct from v_identity_user) and
        (v_binding.id is null or p_action->>'verified_phone_e164' is distinct from v_binding.phone_e164)) then
      raise exception 'vendor identity unverified'; end if;
  elsif v_kind in ('submit_resident_windows','confirm_resident') then
    if nullif(lower(trim(p_action->>'resident_email')),'') is distinct from lower(v_work.resident_email) then
      raise exception 'resident identity mismatch'; end if;
  elsif v_kind in ('select_time','approve_manager','decline_manager','cancel','request_revision','take_over') then
    if v_actor is distinct from v_proposal.manager_user_id then raise exception 'manager approval required'; end if;
  else raise exception 'unknown coordination action'; end if;
  if v_proposal.manager_takeover and v_kind in ('revise_quote','submit_vendor_windows','confirm_vendor')
    and nullif(p_action->>'verified_phone_e164','') is not null then
    raise exception 'manager has taken over SMS coordination';
  end if;
  if v_source is not null then
    select input_hash into v_existing_hash from public.vendor_coordination_operations
      where proposal_id = v_proposal.id and source_message_id = v_source and action_kind = v_kind;
    if found then
      if v_existing_hash <> v_input_hash then raise exception 'message action reused with changed input'; end if;
      return to_jsonb(v_proposal);
    end if;
  end if;
  v_version := nullif(p_action->>'expected_version','')::integer;
  if v_version is distinct from v_proposal.version then raise exception 'stale coordination version'; end if;
  if v_kind = 'cancel' and v_proposal.status = 'cancelled' then return to_jsonb(v_proposal); end if;
  if v_proposal.status in ('approved','cancelled','declined') and v_kind <> 'cancel' then
    raise exception 'coordination proposal closed'; end if;

  if v_source is not null then
    update public.vendor_coordination_proposals set source_message_ids =
      case when source_message_ids ? v_source then source_message_ids else source_message_ids || jsonb_build_array(v_source) end
      where id = v_proposal.id;
  end if;

  if v_kind in ('request_revision','take_over') then
    if nullif(trim(p_action->>'reason'),'') is null or length(trim(p_action->>'reason')) > 1000 then
      raise exception 'manager reason required'; end if;
    if v_kind = 'request_revision' then
      update public.vendor_coordination_proposals set revision_reason = trim(p_action->>'reason'),
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, status = 'collecting', version = version + 1,
        updated_at = now() where id = v_proposal.id;
    else
      update public.vendor_coordination_proposals set manager_takeover = true,
        takeover_reason = trim(p_action->>'reason'), takeover_at = now(),
        version = version + 1, updated_at = now() where id = v_proposal.id;
    end if;
  elsif v_kind = 'revise_quote' then
    v_quote := p_action->'quote';
    v_duration := nullif(p_action->>'duration_minutes','')::integer;
    if jsonb_typeof(v_quote) is distinct from 'object' or v_duration is null or v_duration not between 15 and 480
      or nullif(trim(v_quote->>'scope'),'') is null or length(v_quote->>'scope') > 4000
      or length(coalesce(v_quote->>'exclusions','')) > 4000
      or coalesce(v_quote->>'laborCents','') !~ '^[0-9]{1,10}$'
      or coalesce(v_quote->>'materialsCents','') !~ '^[0-9]{1,10}$'
      or coalesce(v_quote->>'consultationFeeCents','') !~ '^[0-9]{1,10}$' then
      raise exception 'invalid coordination quote'; end if;
    if (v_quote->>'laborCents')::bigint > 1000000000 or (v_quote->>'materialsCents')::bigint > 1000000000
      or (v_quote->>'consultationFeeCents')::bigint > 1000000000 then raise exception 'quote exceeds limit'; end if;
    v_total := case when v_proposal.visit_type = 'consultation' then (v_quote->>'consultationFeeCents')::integer
      else (v_quote->>'laborCents')::integer + (v_quote->>'materialsCents')::integer end;
    if v_total > 1000000000 or (v_proposal.visit_type = 'repair' and v_total <= 0) then
      raise exception 'invalid quote total'; end if;
    update public.vendor_coordination_proposals set
      labor_cents = (v_quote->>'laborCents')::integer, materials_cents = (v_quote->>'materialsCents')::integer,
      consultation_fee_cents = (v_quote->>'consultationFeeCents')::integer,
      scope = trim(v_quote->>'scope'), exclusions = coalesce(trim(v_quote->>'exclusions'),''),
      duration_minutes = v_duration, quote_revision = quote_revision + 1,
      vendor_confirmed_revision = null, resident_confirmed_revision = null,
      status = 'collecting', version = version + 1, updated_at = now()
      where id = v_proposal.id;
  elsif v_kind in ('submit_vendor_windows','submit_resident_windows') then
    v_windows := p_action->'windows';
    if jsonb_typeof(v_windows) is distinct from 'array' or jsonb_array_length(v_windows) > 32 then
      raise exception 'invalid windows'; end if;
    for v_window in select value from jsonb_array_elements(v_windows) loop
      if nullif(v_window->>'startIso','') is null or nullif(v_window->>'endIso','') is null then
        raise exception 'window endpoints required'; end if;
      v_start := (v_window->>'startIso')::timestamptz;
      v_end := (v_window->>'endIso')::timestamptz;
      if v_start >= v_end or v_end > now() + interval '180 days' or v_end <= now()
        or v_end - v_start > interval '24 hours' then raise exception 'invalid window interval'; end if;
    end loop;
    if v_kind = 'submit_vendor_windows' then
      update public.vendor_coordination_proposals set vendor_windows = v_windows,
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, selected_start_at = null, status = 'collecting',
        version = version + 1, updated_at = now() where id = v_proposal.id;
    else
      update public.vendor_coordination_proposals set resident_windows = v_windows,
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, selected_start_at = null, status = 'collecting',
        version = version + 1, updated_at = now() where id = v_proposal.id;
    end if;
  elsif v_kind = 'select_time' then
    v_start := nullif(p_action->>'selected_start_iso','')::timestamptz;
    if v_start is null or v_start <= now() or v_proposal.duration_minutes is null then raise exception 'invalid visit time'; end if;
    v_end := v_start + make_interval(mins => v_proposal.duration_minutes);
    if not exists (select 1 from jsonb_array_elements(v_proposal.vendor_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end)
       or not exists (select 1 from jsonb_array_elements(v_proposal.resident_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end) then
      raise exception 'selected time outside agreed windows'; end if;
    update public.vendor_coordination_proposals set selected_start_at = v_start,
      quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
      resident_confirmed_revision = null, status = 'collecting', version = version + 1,
      updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'confirm_vendor' then
    if v_proposal.selected_start_at is null or v_proposal.duration_minutes is null or v_proposal.scope is null then
      raise exception 'proposal terms incomplete'; end if;
    update public.vendor_coordination_proposals set vendor_confirmed_revision = quote_revision,
      status = case when resident_confirmed_revision = quote_revision then 'ready' else 'collecting' end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'confirm_resident' then
    if v_proposal.selected_start_at is null or v_proposal.duration_minutes is null or v_proposal.scope is null then
      raise exception 'proposal terms incomplete'; end if;
    update public.vendor_coordination_proposals set resident_confirmed_revision = quote_revision,
      status = case when vendor_confirmed_revision = quote_revision then 'ready' else 'collecting' end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'decline_manager' then
    update public.vendor_coordination_proposals set status = 'declined', version = version + 1,
      updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'cancel' then
    perform set_config('proplane.vendor_coordination_write','on',true);
    update public.vendor_coordination_reservations set status = 'cancelled'
      where proposal_id = v_proposal.id and status = 'active';
    update public.vendor_coordination_proposals set status = 'cancelled', version = version + 1,
      updated_at = now() where id = v_proposal.id;
    if v_proposal.status = 'approved' and v_proposal.visit_type = 'repair' then
      update public.portal_work_order_records set row_data =
        (row_data - 'scheduledAtIso' - 'scheduled' - 'visitDurationMinutes') || jsonb_build_object('bucket','open'),
        updated_at = now() where id = v_work.id and row_data->>'scheduledAtIso' = to_char(v_proposal.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    elsif v_proposal.status = 'approved' and v_proposal.visit_type = 'consultation' then
      update public.portal_work_order_records set row_data =
        row_data - 'consultationVisitAt' - 'consultationDurationMinutes', updated_at = now()
        where id = v_work.id and row_data->>'consultationVisitAt' =
          to_char(v_proposal.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;
  elsif v_kind = 'approve_manager' then
    perform set_config('proplane.vendor_coordination_write','on',true);
    if v_proposal.status <> 'ready' or v_proposal.quote_revision = 0
      or v_proposal.vendor_confirmed_revision is distinct from v_proposal.quote_revision
      or v_proposal.resident_confirmed_revision is distinct from v_proposal.quote_revision
      or v_proposal.selected_start_at is null or v_proposal.duration_minutes is null
      or v_verified_phone is null then raise exception 'proposal lacks exact participant agreement or verified phone'; end if;
    v_start := v_proposal.selected_start_at;
    v_end := v_start + make_interval(mins => v_proposal.duration_minutes);
    if v_start <= now() then raise exception 'visit time has passed'; end if;
    if not exists (select 1 from jsonb_array_elements(v_proposal.vendor_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end)
       or not exists (select 1 from jsonb_array_elements(v_proposal.resident_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end) then
      raise exception 'confirmed slot no longer available'; end if;
    -- Lock both canonical identities. Every coordination approval takes the phone lock,
    -- plus the account lock when linked, before checking intervals across managers.
    perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:phone:' || v_verified_phone,0));
    if v_identity_user is not null then
      perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || v_identity_user::text,0));
    end if;
    if exists (select 1 from public.vendor_coordination_reservations r
      left join public.manager_vendor_records historical_directory on historical_directory.id = r.vendor_directory_id
      where r.status = 'active'
      and r.proposal_id <> v_proposal.id and r.starts_at < v_end and r.ends_at > v_start
      and (r.vendor_phone_e164 = v_verified_phone or
        (v_identity_user is not null and
          (r.vendor_user_id = v_identity_user or historical_directory.vendor_user_id = v_identity_user)))) then
      raise exception 'vendor has a conflicting reservation'; end if;
    if exists (select 1 from public.portal_work_order_records legacy
      left join public.manager_vendor_records linked on linked.id = legacy.row_data->>'vendorId'
      left join public.vendor_coordination_phone_bindings lb on lb.vendor_directory_id = linked.id and lb.revoked_at is null
      where legacy.id <> v_work.id and coalesce(legacy.row_data->>'bucket','') not in ('completed','cancelled')
        and legacy.row_data->>'scheduledAtIso' is not null
        and (lb.phone_e164 = v_verified_phone or
          (v_identity_user is not null and (legacy.vendor_user_id = v_identity_user or linked.vendor_user_id = v_identity_user)))
        and (legacy.row_data->>'scheduledAtIso')::timestamptz < v_end
        and (legacy.row_data->>'scheduledAtIso')::timestamptz +
          make_interval(mins => coalesce(nullif(legacy.row_data->>'visitDurationMinutes','')::integer,60)) > v_start) then
      raise exception 'vendor has a conflicting scheduled service'; end if;
    if v_proposal.visit_type = 'repair' then
      v_total := v_proposal.labor_cents + v_proposal.materials_cents;
      if v_total is null or v_total <= 0 then raise exception 'repair quote missing'; end if;
      if exists (select 1 from public.work_order_bids b where b.work_order_id = v_work.id and b.status = 'accepted'
        and b.vendor_directory_id is distinct from v_proposal.vendor_directory_id) then
        raise exception 'another vendor bid already accepted'; end if;
      select * into v_bid from public.work_order_bids where work_order_id = v_work.id
        and vendor_directory_id = v_proposal.vendor_directory_id for update;
      if found and v_bid.status = 'accepted' then raise exception 'bid already accepted'; end if;
      if found then
        update public.work_order_bids set amount_cents = v_proposal.labor_cents,
          materials_cents = v_proposal.materials_cents, vendor_user_id = v_identity_user,
          proposed_time = v_start, note = v_proposal.scope, status = 'accepted', updated_at = now()
          where id = v_bid.id returning * into v_bid;
      else
        insert into public.work_order_bids(work_order_id,vendor_user_id,vendor_directory_id,manager_user_id,
          amount_cents,materials_cents,proposed_time,note,status,quote_mode)
        values(v_work.id,v_identity_user,v_proposal.vendor_directory_id,v_proposal.manager_user_id,
          v_proposal.labor_cents,v_proposal.materials_cents,v_start,v_proposal.scope,'accepted','upfront')
        returning * into v_bid;
      end if;
      update public.work_order_bids set status = 'declined', updated_at = now()
        where work_order_id = v_work.id and id <> v_bid.id and status = 'submitted';
      update public.portal_work_order_records set
        vendor_user_id = v_identity_user,
        row_data = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
          row_data || jsonb_build_object('vendorId',v_proposal.vendor_directory_id,
            'vendorCostCents',v_proposal.labor_cents,'materialsCostCents',v_proposal.materials_cents,
            'cost','$' || to_char(v_total::numeric / 100,'FM9999999990.00'),
            'scheduled',to_char(v_start at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM'),
            'biddingOpen',false,'bucket','scheduled','visitDurationMinutes',v_proposal.duration_minutes),
          '{scheduledAtIso}',to_jsonb(to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
          '{vendorName}',coalesce(v_directory.row_data->'name','null'::jsonb)),
          '{quoteScope}',to_jsonb(v_proposal.scope)),
          '{quoteExclusions}',to_jsonb(v_proposal.exclusions)),
          '{coordinationProposalId}',to_jsonb(v_proposal.id::text)), updated_at = now()
        where id = v_work.id;
    else
      -- A consultation has an independent fee approval and does not resolve repair bidding.
      update public.portal_work_order_records set row_data = row_data || jsonb_build_object(
        'consultationVisitAt',to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'consultationDurationMinutes',v_proposal.duration_minutes,
        'consultationFeeCents',v_proposal.consultation_fee_cents,
        'consultationCoordinationProposalId',v_proposal.id::text), updated_at = now()
        where id = v_work.id;
    end if;
    insert into public.vendor_coordination_reservations
      (proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,vendor_phone_e164,starts_at,ends_at)
    values(v_proposal.id,v_work.id,v_proposal.manager_user_id,v_proposal.vendor_directory_id,
      v_identity_user,v_verified_phone,v_start,v_end);
    update public.vendor_coordination_proposals set status = 'approved', approved_by = v_actor,
      approved_at = now(), accepted_bid_id = case when v_proposal.visit_type = 'repair' then v_bid.id else null end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':booked:' || v_proposal.quote_revision::text,
      'work_order','scheduled','maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'propertyId',v_work.property_id,
        'startsAt',v_start,'endsAt',v_end,
        'durationMinutes',v_proposal.duration_minutes,'scope',v_proposal.scope,
        'exclusions',v_proposal.exclusions,'laborCents',v_proposal.labor_cents,
        'materialsCents',v_proposal.materials_cents,'consultationFeeCents',v_proposal.consultation_fee_cents,
        'quoteRevision',v_proposal.quote_revision))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is null then raise exception 'duplicate booked event key'; end if;
    insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
      status,next_attempt_at,rendered)
    values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object('subject','Service visit booked',
        'text','The ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text ||
        '. Scope: ' || v_proposal.scope || '.',
        'smsText','Service ' || v_proposal.visit_type || ' booked for ' || v_start::text || '.'));
    if nullif(trim(v_work.resident_email),'') is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
        status,next_attempt_at,rendered)
      values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
        'pending',now(),jsonb_build_object('subject','Your service visit is booked',
          'text','Your confirmed ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text || '.',
          'smsText','Your confirmed service visit is booked for ' || v_start::text || '.'));
    end if;
    if v_identity_user is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        recipient_email,status,next_attempt_at,rendered)
      values(v_event_id,'vendor',coalesce(v_identity_user::text,lower(trim(v_directory.row_data->>'email'))),
        v_identity_user,nullif(lower(trim(v_directory.row_data->>'email')),''),
        'pending',now(),jsonb_build_object('subject','Service visit booked',
          'text','The confirmed ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text || '.',
          'smsText','Confirmed service visit booked for ' || v_start::text || '.'));
    end if;
  end if;
  select * into v_proposal from public.vendor_coordination_proposals where id = v_proposal.id;
  if v_source is not null then
    insert into public.vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash)
      values(v_proposal.id,v_source,v_kind,v_input_hash);
  end if;
  if v_kind <> 'approve_manager' then
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':version:' || v_proposal.version::text,
      'work_order',case when v_kind = 'cancel' then 'cancelled' else 'coordination_updated' end,
      'maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'version',v_proposal.version,
        'propertyId',v_work.property_id,
        'reason',case when v_kind = 'request_revision' then v_proposal.revision_reason
          when v_kind = 'take_over' then v_proposal.takeover_reason else null end,
        'managerTakeover',v_proposal.manager_takeover,
        'quoteRevision',v_proposal.quote_revision,'action',v_kind,
        'startsAt',v_proposal.selected_start_at,'scope',v_proposal.scope,
        'laborCents',v_proposal.labor_cents,'materialsCents',v_proposal.materials_cents,
        'consultationFeeCents',v_proposal.consultation_fee_cents))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        status,next_attempt_at,rendered)
      values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object(
          'subject',case when v_proposal.status = 'ready' then 'Service proposal ready for approval'
            else 'Service coordination updated' end,
          'text',case when v_proposal.status = 'ready' then
            'Ready for approval: ' || coalesce(v_directory.row_data->>'name','Vendor') ||
            ', ' || v_proposal.visit_type || ', scope: ' || coalesce(v_proposal.scope,'') ||
            ', exclusions: ' || coalesce(v_proposal.exclusions,'') || ', total: $' ||
            to_char((case when v_proposal.visit_type = 'consultation' then v_proposal.consultation_fee_cents
              else v_proposal.labor_cents + v_proposal.materials_cents end)::numeric / 100,'FM9999999990.00') ||
            ', duration: ' || v_proposal.duration_minutes::text || ' minutes, ' ||
            to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
            ' Pacific. Vendor and resident confirmed revision ' || v_proposal.quote_revision::text || '.'
            else 'The ' || v_proposal.visit_type || ' visit proposal was updated (' || v_kind || ').' end));
      if v_kind in ('request_revision','take_over','cancel','decline_manager','select_time','submit_resident_windows')
        and (v_identity_user is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null) then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
          recipient_email,status,next_attempt_at,rendered)
        values(v_event_id,'vendor',coalesce(v_identity_user::text,lower(trim(v_directory.row_data->>'email'))),
          v_identity_user,nullif(lower(trim(v_directory.row_data->>'email')),''),'pending',now(),
          jsonb_build_object('subject','Service coordination update',
            'text',case when v_kind = 'request_revision' then 'The manager requested a revision: ' || v_proposal.revision_reason
              when v_kind = 'take_over' then 'The manager will coordinate this service directly.'
              when v_kind = 'cancel' then 'The service visit was cancelled.'
              when v_kind = 'select_time' then 'Please confirm the exact ' || v_proposal.visit_type ||
                ' visit: ' || to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
                ' Pacific for ' || v_proposal.duration_minutes::text || ' minutes. This is a proposal, not a booking.'
              when v_kind = 'submit_resident_windows' then 'The resident sent visit windows. Review the proposed time with the manager.'
              else 'The proposed service visit was declined.' end));
      end if;
      if v_kind in ('revise_quote','submit_vendor_windows','select_time','cancel')
        and nullif(trim(v_work.resident_email),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
          status,next_attempt_at,rendered)
        values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
          'pending',now(),jsonb_build_object(
            'subject',case when v_kind = 'cancel' then 'Service visit cancelled'
              when v_kind = 'select_time' then 'Confirm a service visit time'
              else 'Choose windows for a service visit' end,
            'text',case when v_kind = 'cancel' then 'The ' || v_proposal.visit_type || ' visit was cancelled.'
              when v_kind = 'select_time' then 'Please confirm the exact ' || v_proposal.visit_type ||
                ' visit: ' || to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
                ' Pacific for ' || v_proposal.duration_minutes::text || ' minutes in Resident Services. No appointment is booked yet.'
              else 'Please submit available windows for a ' || v_proposal.visit_type ||
                ' visit in Resident Services. No appointment is booked yet.' end));
      end if;
    end if;
  end if;
  return to_jsonb(v_proposal);
end $$;

-- Sourcing derives and verifies the same directory before row locks.
create or replace function public.enroll_vendor_sourcing_candidate(p_candidate_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_sourcing_candidates; j public.vendor_sourcing_jobs; w public.portal_work_order_records;
 d public.manager_vendor_records; local_id text; proposal jsonb; expiry timestamptz;
 v_expected_manager uuid; v_expected_work text; v_expected_directory text;
begin
 -- Read only to derive the directory fence before locking the service or rows.
 select sj.manager_user_id,sj.work_order_id,
   case when sc.source='roster' then sc.source_directory_id
     else 'sourced-'||md5(sj.manager_user_id::text||':'||sc.dedupe_key) end
 into v_expected_manager,v_expected_work,v_expected_directory
 from public.vendor_sourcing_candidates sc
 join public.vendor_sourcing_jobs sj on sj.id=sc.job_id where sc.id=p_candidate_id;
 if v_expected_directory is null or v_expected_work is null then raise exception 'sourcing candidate missing'; end if;
 perform public.lock_vendor_directory(v_expected_directory);
 perform public.lock_vendor_service(v_expected_work);
 select * into c from public.vendor_sourcing_candidates where id=p_candidate_id for update;
 select * into j from public.vendor_sourcing_jobs where id=c.job_id for update;
 if c.id is null or j.id is null or j.manager_user_id is distinct from v_expected_manager
   or j.work_order_id is distinct from v_expected_work
   or (case when c.source='roster' then c.source_directory_id
      else 'sourced-'||md5(j.manager_user_id::text||':'||c.dedupe_key) end)
      is distinct from v_expected_directory then
   raise exception using errcode='40001',message='sourcing directory changed during enrollment';
 end if;
 if j.lease_token is distinct from p_lease_token or j.lease_until<now() or j.state not in ('queued','sourcing','waiting') then raise exception 'sourcing lease lost'; end if;
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

-- Identity-only proposal updates do not change sourcing lifecycle.
create or replace function public.wake_vendor_sourcing_quote() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Identity attachment and bookkeeping metadata cannot wake a sourcing job.
 if row(new.status,new.manager_takeover,new.accepted_bid_id,new.version,new.quote_revision,
   new.labor_cents,new.materials_cents,new.consultation_fee_cents,new.scope,
   new.exclusions,new.duration_minutes,new.vendor_windows,new.resident_windows,
   new.selected_start_at,new.vendor_confirmed_revision,new.resident_confirmed_revision,
   new.revision_reason,new.takeover_reason,new.takeover_at,new.approved_by,new.approved_at)
   is not distinct from
   row(old.status,old.manager_takeover,old.accepted_bid_id,old.version,old.quote_revision,
   old.labor_cents,old.materials_cents,old.consultation_fee_cents,old.scope,
   old.exclusions,old.duration_minutes,old.vendor_windows,old.resident_windows,
   old.selected_start_at,old.vendor_confirmed_revision,old.resident_confirmed_revision,
   old.revision_reason,old.takeover_reason,old.takeover_at,old.approved_by,old.approved_at) then
   return new;
 end if;
 if new.status in ('declined','cancelled') and old.status not in ('declined','cancelled') then
  -- Manager rejection must not keep recontacting the rejected candidate. A separate
  -- remaining live proposal for this vendor (for example consultation) stays usable.
  if not exists(select 1 from public.vendor_coordination_proposals p where p.work_order_id=new.work_order_id
    and p.manager_user_id=new.manager_user_id and p.vendor_directory_id=new.vendor_directory_id
    and p.status in ('collecting','ready','approved')) then
   update public.work_order_vendor_offers set status='declined',declined_reason=coalesce(new.revision_reason,'Quote withdrawn'),declined_at=now(),updated_at=now()
    where work_order_id=new.work_order_id and manager_user_id=new.manager_user_id and vendor_directory_id=new.vendor_directory_id and status='sent';
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
