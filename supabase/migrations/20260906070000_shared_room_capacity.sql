-- Serialize placement writes and capacity edits on the property row. Tested on local PostgreSQL.
-- Every direct table writer is covered. Browser-facing roles get no new privileges.
alter table public.manager_property_records
  add column if not exists occupancy_revision bigint not null default 0;

-- Renewal terms drive billing; this server-owned floor preserves the current
-- continuously occupied bed when a future renewal is signed early.
alter table public.manager_application_records add column if not exists occupancy_start date;

create or replace function public.room_placement_day(p_value text)
returns date language plpgsql immutable set search_path = '' as $$
declare parts text[];
begin
  if nullif(btrim(p_value), '') is null then return null; end if;
  if p_value ~ '^\d{4}-\d{2}-\d{2}$' then
    return p_value::date;
  elsif p_value ~ '^\d{1,2}/\d{1,2}/\d{4}$' then
    parts := string_to_array(p_value, '/');
    return make_date(parts[3]::int, parts[1]::int, parts[2]::int);
  end if;
  raise exception using errcode = '23514', message = 'Placement date must be a valid calendar date.';
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception using errcode = '23514', message = 'Placement date must be a valid calendar date.';
end;
$$;

create or replace function public.room_placement_application_key(p_id text)
returns text language sql immutable set search_path = '' as $$
  select case when upper(btrim(p_id)) like 'AXIS-%' or upper(btrim(p_id)) like 'PROPLANE-%'
    then upper(btrim(p_id))
    else 'PROPLANE-' || left(upper(regexp_replace(btrim(p_id), '[^a-zA-Z0-9]', '', 'g')), 12) end
$$;

create or replace function public.room_placement_property(p_row jsonb)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(p_row->>'assignedPropertyId'), ''),
    nullif(btrim(p_row->>'propertyId'), ''), nullif(btrim(p_row#>>'{application,propertyId}'), ''))
$$;

create or replace function public.room_placement_room(p_row jsonb, p_rooms jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare choice text; rid text; matches text[];
begin
  choice := coalesce(nullif(btrim(p_row->>'assignedRoomChoice'), ''),
    nullif(btrim(p_row#>>'{application,roomChoice1}'), ''));
  if choice = public.room_placement_property(p_row) then return '__whole_property__'; end if;
  if position('::' in choice) > 0 then
    -- Reject a structured placement that names a different property.
    if split_part(choice, '::', 1) is distinct from public.room_placement_property(p_row) then
      raise exception using errcode = '23514', message = 'Room does not belong to the assigned property.';
    end if;
    rid := substring(choice from position('::' in choice) + 2);
    if exists(select 1 from jsonb_array_elements(p_rooms) room where room->>'id' = rid) then return rid; end if;
    raise exception using errcode = '23514', message = 'Assigned room no longer exists.';
  end if;
  select array_agg(room->>'id') into matches from jsonb_array_elements(p_rooms) room
    where room->>'id' = choice or lower(btrim(room->>'name')) = lower(coalesce(nullif(btrim(p_row#>>'{manualResidentDetails,roomNumber}'), ''), choice));
  if array_length(matches, 1) = 1 then return matches[1]; end if;
  raise exception using errcode = '23514', message = 'Assign a valid room before approving this application.';
end;
$$;

-- Caller MUST already own the property row write lock. VOLATILE is deliberate:
-- this query receives a fresh command snapshot after any preceding lock wait.
create or replace function public.assert_room_placement_capacity(
  p_property_id text, p_owner uuid, p_submission jsonb,
  p_candidate jsonb default null, p_exclude_id text default null
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  rooms jsonb := coalesce(p_submission->'rooms', '[]'::jsonb);
  placements jsonb := '[]'::jsonb;
  rec record; row_value jsonb; room_id text; begin_day date; end_day date;
  room jsonb; capacity_value numeric; max_count bigint; unavailable jsonb;
  candidate_room text; candidate_start date; candidate_end date;
begin
  -- Whole-house and legacy placements need explicit migration decisions. Do not
  -- silently return "available" because a referenced listing/room is unresolved.
  if jsonb_typeof(rooms) <> 'array' or jsonb_array_length(rooms) = 0 then
    rooms := '[{"id":"__whole_property__","name":"Entire property","occupancyCapacity":1}]'::jsonb;
  end if;
  for rec in
    select distinct on (public.room_placement_application_key(a.id)) a.row_data || jsonb_build_object('_occupancyStart', a.occupancy_start) as body
      from public.manager_application_records a
      where a.manager_user_id = p_owner and a.row_data->>'bucket' = 'approved'
        and nullif(a.row_data->>'withdrawnAt', '') is null
        and public.room_placement_property(a.row_data) = p_property_id
        and (p_exclude_id is null or public.room_placement_application_key(a.id)
          <> public.room_placement_application_key(p_exclude_id))
      order by public.room_placement_application_key(a.id), a.updated_at desc
  loop
    placements := placements || jsonb_build_array(rec.body);
  end loop;
  if p_candidate is not null and p_candidate->>'bucket' = 'approved' then
    placements := placements || jsonb_build_array(p_candidate);
  end if;
  if p_candidate is not null then
    candidate_room := public.room_placement_room(p_candidate, rooms);
    candidate_start := least(public.room_placement_day(p_candidate->>'_occupancyStart'), coalesce(public.room_placement_day(p_candidate#>>'{manualResidentDetails,moveInDate}'), public.room_placement_day(p_candidate#>>'{application,leaseStart}'), (now() at time zone 'America/Los_Angeles')::date));
    candidate_end := coalesce(public.room_placement_day(p_candidate#>>'{manualResidentDetails,moveOutDate}'), public.room_placement_day(p_candidate#>>'{application,leaseEnd}'), 'infinity'::date);
  end if;
  -- Use a temporary JSON value rather than a shared table or session GUC flag.
  -- Store only normalized anonymous intervals in it.
  declare normalized jsonb := '[]'::jsonb;
  begin
    for row_value in select value from jsonb_array_elements(placements) loop
      room_id := public.room_placement_room(row_value, rooms);
      begin_day := least(public.room_placement_day(row_value->>'_occupancyStart'), coalesce(
        public.room_placement_day(row_value#>>'{manualResidentDetails,moveInDate}'),
        public.room_placement_day(row_value#>>'{application,leaseStart}'),
        (now() at time zone 'America/Los_Angeles')::date));
      end_day := coalesce(
        public.room_placement_day(row_value#>>'{manualResidentDetails,moveOutDate}'),
        public.room_placement_day(row_value#>>'{application,leaseEnd}'),
        'infinity'::date);
      if end_day < begin_day then
        raise exception using errcode = '23514', message = 'Move-out date precedes move-in date.';
      end if;
      normalized := normalized || jsonb_build_array(jsonb_build_object(
        'room', room_id, 'start', begin_day::text, 'end', end_day::text));
    end loop;
    for room in select value from jsonb_array_elements(rooms) loop
      if candidate_room is not null and candidate_room <> '__whole_property__' and candidate_room <> room->>'id' then continue; end if;
      -- Same accepted range/default as normalizeRoomOccupancyCapacity. An explicit
      -- invalid SAVE is rejected by the listing route before normalization.
      begin
        capacity_value := nullif(btrim(room->>'occupancyCapacity'), '')::numeric;
      exception when invalid_text_representation or numeric_value_out_of_range then capacity_value := null;
      end;
      if capacity_value is null or capacity_value <> trunc(capacity_value)
        or capacity_value < 1 or capacity_value > 20 then capacity_value := 1; end if;
      with spans as (
        select greatest((p->>'start')::date, coalesce(candidate_start, (now() at time zone 'America/Los_Angeles')::date)) s, least((p->>'end')::date, coalesce(candidate_end, 'infinity'::date)) e,
          case when p->>'room' = '__whole_property__' then capacity_value else 1 end weight
        from jsonb_array_elements(normalized) p where p->>'room' in (room->>'id', '__whole_property__')
      ), events as (
        select s d, weight n from spans where s <= e
        union all
        select e + 1, -weight from spans where isfinite(e) and s <= e
      ), deltas as (select d, sum(n) n from events group by d),
      running as (select sum(n) over(order by d rows unbounded preceding) n from deltas)
      select coalesce(max(n), 0) into max_count from running;
      if max_count > capacity_value then
        raise exception using errcode = 'P4001', message = 'No bed is available in this room for the requested dates.';
      end if;
      -- A blocked period rejects NEW placement, not the mere presence of an
      -- already-approved historical resident during a manager maintenance block.
      if p_candidate is not null and candidate_room in (room->>'id', '__whole_property__') then
        begin_day := coalesce(public.room_placement_day(p_candidate#>>'{manualResidentDetails,moveInDate}'),
          public.room_placement_day(p_candidate#>>'{application,leaseStart}'), (now() at time zone 'America/Los_Angeles')::date);
        end_day := coalesce(public.room_placement_day(p_candidate#>>'{manualResidentDetails,moveOutDate}'),
          public.room_placement_day(p_candidate#>>'{application,leaseEnd}'), 'infinity'::date);
        for unavailable in select value from jsonb_array_elements(coalesce(room->'manualUnavailableRanges', '[]'::jsonb)) loop
          if public.room_placement_day(unavailable->>'start') <= end_day
            and public.room_placement_day(unavailable->>'end') >= begin_day then
            raise exception using errcode = 'P4001', message = 'This room is blocked for the requested dates.';
          end if;
        end loop;
      end if;
    end loop;
  end;
end;
$$;

create or replace function public.enforce_application_room_capacity()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare prop public.manager_property_records%rowtype; property_id text;
begin
  if new.row_data->>'bucket' is distinct from 'approved' then return new; end if;
  if nullif(new.row_data->>'withdrawnAt', '') is not null then
    raise exception using errcode = '23514', message = 'Withdrawn applications cannot be approved.';
  end if;
  -- Metadata-only edits cannot newly consume a bed or collide with a later block.
  if tg_op = 'UPDATE' and old.row_data->>'bucket' = 'approved'
    and old.occupancy_start is not distinct from new.occupancy_start
    and old.manager_user_id is not distinct from new.manager_user_id
    and public.room_placement_property(old.row_data) is not distinct from public.room_placement_property(new.row_data)
    and old.row_data->>'assignedRoomChoice' is not distinct from new.row_data->>'assignedRoomChoice'
    and old.row_data#>'{application,roomChoice1}' is not distinct from new.row_data#>'{application,roomChoice1}'
    and old.row_data#>'{application,leaseStart}' is not distinct from new.row_data#>'{application,leaseStart}'
    and old.row_data#>'{application,leaseEnd}' is not distinct from new.row_data#>'{application,leaseEnd}'
    and old.row_data#>'{manualResidentDetails,roomNumber}' is not distinct from new.row_data#>'{manualResidentDetails,roomNumber}'
    and old.row_data#>'{manualResidentDetails,moveInDate}' is not distinct from new.row_data#>'{manualResidentDetails,moveInDate}'
    and old.row_data#>'{manualResidentDetails,moveOutDate}' is not distinct from new.row_data#>'{manualResidentDetails,moveOutDate}' then return new; end if;
  property_id := public.room_placement_property(new.row_data);
  -- Actually update a shared row, do not just take an advisory lock. A stale
  -- repeatable-read transaction must fail 40001, rather than count an old snapshot.
  update public.manager_property_records p
    set occupancy_revision = p.occupancy_revision + 1
    where p.id = property_id and p.manager_user_id = new.manager_user_id
    returning p.* into prop;
  if not found then
    raise exception using errcode = '23514', message = 'Assigned property is unavailable to this owner.';
  end if;
  perform public.assert_room_placement_capacity(property_id, prop.manager_user_id,
    coalesce(prop.property_data->'listingSubmission', prop.row_data->'submission'), new.row_data || jsonb_build_object('_occupancyStart', new.occupancy_start), new.id);
  return new;
end;
$$;
create trigger enforce_application_room_capacity
  after insert or update on public.manager_application_records
  for each row execute function public.enforce_application_room_capacity();

create or replace function public.enforce_property_room_capacity()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if (coalesce(new.property_data->'listingSubmission', new.row_data->'submission')->'rooms') is not distinct from
     (coalesce(old.property_data->'listingSubmission', old.row_data->'submission')->'rooms') then return new; end if;
  -- AFTER UPDATE: the heap row was updated and is locked before this read.
  -- Approval writes must acquire that same row before checking occupancy.
  if exists(select 1 from public.manager_application_records a
    where a.manager_user_id = new.manager_user_id and a.row_data->>'bucket' = 'approved'
      and public.room_placement_property(a.row_data) = new.id) then
    perform public.assert_room_placement_capacity(new.id, new.manager_user_id,
      coalesce(new.property_data->'listingSubmission', new.row_data->'submission'));
  end if;
  return new;
end;
$$;
create trigger enforce_property_room_capacity
  after update of property_data, row_data on public.manager_property_records
  for each row execute function public.enforce_property_room_capacity();

-- Route authorization still happens before calling this service-only RPC. Stored
-- snapshots bind that authorization and generated document to the exact records.
create or replace function public.commit_room_lease_extension(
  p_owner uuid, p_application_id text, p_expected_application jsonb,
  p_lease_id text, p_expected_lease jsonb, p_next_lease jsonb, p_end date
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare a public.manager_application_records%rowtype; l public.portal_lease_pipeline_records%rowtype;
  property_id text; touched text;
begin
  property_id := public.room_placement_property(p_expected_application);
  update public.manager_property_records p set occupancy_revision = p.occupancy_revision + 1
    where p.id = property_id and p.manager_user_id = p_owner returning p.id into touched;
  if not found then raise exception using errcode = '23514', message = 'Property unavailable.'; end if;
  select * into a from public.manager_application_records
    where id = p_application_id and manager_user_id = p_owner for update;
  if not found or a.row_data is distinct from p_expected_application
    or a.row_data->>'bucket' is distinct from 'approved' then
    raise exception using errcode = '40001', message = 'Application changed; reload before extending.';
  end if;
  select * into l from public.portal_lease_pipeline_records
    where id = p_lease_id and manager_user_id = p_owner for update;
  if not found or l.row_data is distinct from p_expected_lease or l.property_id is distinct from property_id
    or public.room_placement_application_key(l.row_data->>'axisId')
      is distinct from public.room_placement_application_key(a.id) then
    raise exception using errcode = '40001', message = 'Lease changed; reload before extending.';
  end if;
  if p_end is null or p_next_lease#>>'{application,leaseEnd}' is distinct from p_end::text
    or p_next_lease->>'axisId' is distinct from l.row_data->>'axisId'
    or p_next_lease->>'residentEmail' is distinct from l.row_data->>'residentEmail'
    or p_next_lease->>'roomChoice' is distinct from l.row_data->>'roomChoice' then
    raise exception using errcode = '23514', message = 'Lease date mismatch.';
  end if;
  -- Date updates do not touch encrypted applicant identity or its binding.
  update public.manager_application_records set
    row_data = jsonb_set(jsonb_set(a.row_data,
      '{application}', coalesce(a.row_data->'application', '{}'::jsonb) || jsonb_build_object('leaseEnd', p_end::text)),
      '{manualResidentDetails}', coalesce(a.row_data->'manualResidentDetails', '{}'::jsonb) || jsonb_build_object('moveOutDate', p_end::text)),
    updated_at = now() where id = a.id;
  -- If capacity trigger refuses above, NOTHING (including this lease) commits.
  update public.portal_lease_pipeline_records set row_data = p_next_lease,
    status = 'manager', updated_at = now() where id = l.id;
end;
$$;
revoke all on function public.assert_room_placement_capacity(text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.enforce_application_room_capacity() from public, anon, authenticated;
revoke all on function public.enforce_property_room_capacity() from public, anon, authenticated;
revoke all on function public.commit_room_lease_extension(uuid, text, jsonb, text, jsonb, jsonb, date) from public, anon, authenticated;
grant execute on function public.commit_room_lease_extension(uuid, text, jsonb, text, jsonb, jsonb, date) to service_role;

-- The last renewal signature reserves its placement in this SAME transaction.
-- A refusal rolls back the signature, so no signed promise outlives a lost bed.
create or replace function public.enforce_signed_renewal_room_capacity()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare renewal jsonb; application_id text; touched text;
begin
  renewal := new.row_data->'pendingRenewal';
  if renewal is null or renewal = 'null'::jsonb
    or nullif(new.row_data#>>'{managerSignature,name}', '') is null
    or nullif(new.row_data#>>'{managerSignature,signedAtIso}', '') is null
    or ((nullif(new.row_data#>>'{residentSignature,name}', '') is null or nullif(new.row_data#>>'{residentSignature,signedAtIso}', '') is null)
      and (nullif(new.row_data->>'signatureName', '') is null or nullif(new.row_data->>'signedAtIso', '') is null)) then return new; end if;
  if tg_op = 'UPDATE' and new.row_data is not distinct from old.row_data then return new; end if;
  application_id := new.row_data->>'axisId';
  update public.manager_application_records a set occupancy_start = least(a.occupancy_start, coalesce(public.room_placement_day(a.row_data#>>'{manualResidentDetails,moveInDate}'), public.room_placement_day(a.row_data#>>'{application,leaseStart}'))), row_data =
    jsonb_set(jsonb_set(a.row_data, '{manualResidentDetails}',
      coalesce(nullif(a.row_data->'manualResidentDetails', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('moveInDate', renewal->>'leaseStart', 'moveOutDate', renewal->>'leaseEnd', 'leaseTerm', renewal->>'leaseTerm')),
      '{application}', coalesce(nullif(a.row_data->'application', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('leaseStart', renewal->>'leaseStart', 'leaseEnd', renewal->>'leaseEnd', 'leaseTerm', renewal->>'leaseTerm')),
      updated_at = now()
    where a.id = application_id and a.manager_user_id = new.manager_user_id
      and a.row_data->>'bucket' = 'approved' and nullif(a.row_data->>'withdrawnAt', '') is null
      and public.room_placement_property(a.row_data) = new.property_id
    returning a.id into touched;
  if not found then raise exception using errcode = '23514', message = 'The approved residency must be resolved before signing its renewal.'; end if;
  return new;
end;
$$;
create trigger enforce_signed_renewal_room_capacity
  after insert or update on public.portal_lease_pipeline_records
  for each row execute function public.enforce_signed_renewal_room_capacity();
revoke all on function public.enforce_signed_renewal_room_capacity() from public, anon, authenticated;

-- The historical floor follows this placement only, never a transfer to another room.
create or replace function public.reset_transferred_room_occupancy_start()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare rooms jsonb;
begin
  if old.occupancy_start is null then return new; end if;
  if old.manager_user_id is distinct from new.manager_user_id
    or public.room_placement_property(old.row_data) is distinct from public.room_placement_property(new.row_data) then
    new.occupancy_start := null; return new;
  end if;
  if old.row_data->>'assignedRoomChoice' is distinct from new.row_data->>'assignedRoomChoice'
    or old.row_data#>'{manualResidentDetails,roomNumber}' is distinct from new.row_data#>'{manualResidentDetails,roomNumber}'
    or old.row_data#>'{application,roomChoice1}' is distinct from new.row_data#>'{application,roomChoice1}' then
    select coalesce(p.property_data->'listingSubmission', p.row_data->'submission')->'rooms' into rooms
      from public.manager_property_records p where p.id = public.room_placement_property(new.row_data) and p.manager_user_id = new.manager_user_id;
    if public.room_placement_room(old.row_data, coalesce(rooms, '[]'::jsonb)) is distinct from public.room_placement_room(new.row_data, coalesce(rooms, '[]'::jsonb)) then new.occupancy_start := null; end if;
  end if;
  return new;
end;
$$;
create trigger reset_transferred_room_occupancy_start before update on public.manager_application_records
  for each row execute function public.reset_transferred_room_occupancy_start();
revoke all on function public.reset_transferred_room_occupancy_start() from public, anon, authenticated;

-- Preserve the server-owned occupancy floor when normalizing a legacy ID.
-- Preserve encrypted document aliases and logical children when a legacy
-- application primary key becomes its canonical display ID. Object paths are
-- immutable: their folder already normalizes both IDs, and paths bind the AAD.
create or replace function public.normalize_application_record_id(
  p_old_id text,
  p_expected jsonb,
  p_next jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row public.manager_application_records%rowtype;
  new_id text := p_next->>'id';
begin
  if p_old_id is null or p_old_id = '' or new_id is null or new_id = '' or new_id = p_old_id
     or jsonb_typeof(p_expected) is distinct from 'object'
     or jsonb_typeof(p_next->'row_data') is distinct from 'object'
     or p_next->'row_data'->>'id' is distinct from new_id then
    raise exception 'Invalid application normalization request';
  end if;

  if new_id is distinct from (case
    when upper(btrim(p_old_id)) like 'AXIS-%' or upper(btrim(p_old_id)) like 'PROPLANE-%' then btrim(p_old_id)
    else 'PROPLANE-' || left(upper(regexp_replace(btrim(p_old_id), '[^a-zA-Z0-9]', '', 'g')), 12)
  end) then raise exception 'Invalid application normalization target'; end if;

  select * into old_row from public.manager_application_records where id = p_old_id for update;
  if not found then raise exception 'Application normalization source unavailable'; end if;
  -- Both ownership columns and row_data are the previously authorized snapshot.
  -- A concurrent submit, transfer, token rotation or document edit must retry.
  if old_row.row_data is distinct from p_expected->'row_data'
     or old_row.manager_user_id is distinct from (p_expected->>'manager_user_id')::uuid
     or old_row.resident_email is distinct from p_expected->>'resident_email'
     or old_row.property_id is distinct from p_expected->>'property_id'
     or old_row.assigned_property_id is distinct from p_expected->>'assigned_property_id'
     or old_row.manager_user_id is distinct from (p_next->>'manager_user_id')::uuid then
    raise exception 'Application normalization source changed';
  end if;

  if p_next->'row_data'->>'bucket' = 'pending'
     and lower(btrim(p_next->'row_data'->>'stage')) = 'in progress'
     and (old_row.row_data->>'bucket' is distinct from 'pending'
       or lower(btrim(old_row.row_data->>'stage')) is distinct from 'in progress'
       or old_row.row_data->>'withdrawnAt' is not null) then
    raise exception 'Application draft is no longer writable';
  end if;

  -- No ON CONFLICT: a different row with this exact target PK is never merged,
  -- even if it has the same manager. The insert also arbitrates concurrent IDs.
  insert into public.manager_application_records
    (id, manager_user_id, resident_email, property_id, assigned_property_id, row_data, created_at, updated_at, occupancy_start)
  values (new_id, old_row.manager_user_id, p_next->>'resident_email',
    p_next->>'property_id', p_next->>'assigned_property_id', p_next->'row_data', old_row.created_at, now(), old_row.occupancy_start);

  update public.application_document_storage_aliases set application_id = new_id where application_id = p_old_id;
  update public.cosigner_submission_records
    set signer_app_id = new_id, row_data = jsonb_set(row_data, '{signerAppId}', to_jsonb(new_id)), updated_at = now()
    where signer_app_id = p_old_id;
  update public.screening_orders set application_id = new_id where application_id = p_old_id;
  update public.application_fee_waiver_redemptions set application_id = new_id where application_id = p_old_id;

  -- The alias FK now points to the new parent, so this cannot cascade its map.
  -- Every step above shares this statement's transaction and rolls back on error.
  delete from public.manager_application_records where id = p_old_id;
end;
$$;
revoke all on function public.normalize_application_record_id(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.normalize_application_record_id(text, jsonb, jsonb) to service_role;
