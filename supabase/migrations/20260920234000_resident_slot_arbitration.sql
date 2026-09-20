-- Arbitrate a concurrent resident-slot pick the same way the bed itself is
-- arbitrated (20260906070000_shared_room_capacity.sql): the API route's
-- `resolveApprovedResidentSlot` re-derives which slot is open with a
-- read-then-write check that is NOT, on its own, safe against two concurrent
-- approvals landing on the same slot at once (PLAN-0920-0631 finding). This
-- extends the existing capacity function so the same serialized write +
-- fresh-snapshot re-check that already catches a full room also catches two
-- approvals claiming the identical resident slot, even when total bed
-- capacity is not exceeded. It reuses the SAME `enforce_application_room_capacity`
-- / `enforce_property_room_capacity` triggers and the SAME P4001 -> 409 path
-- the route already maps (`src/app/api/manager-applications/route.ts`), so no
-- route code changes: additive, idempotent (CREATE OR REPLACE), tested on
-- local PostgreSQL.
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
  per_resident_room boolean; slot_list int[]; slot_no int; slot_max bigint;
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
      -- Carry the application's own stored 1-based resident slot (the exact
      -- field `resolveApprovedResidentSlot` writes on approval) through the
      -- same normalized array the bed count already reads, so a per-slot
      -- conflict can be detected from the very same fresh snapshot.
      normalized := normalized || jsonb_build_array(jsonb_build_object(
        'room', room_id, 'start', begin_day::text, 'end', end_day::text,
        'slot', nullif(row_value#>>'{application,residentSlot}', '')));
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
      -- Resident-slot arbitration (PLAN-0920-0631 race fix): a room that
      -- prices per resident assigns each bed a specific rent via
      -- `application.residentSlot`. Two concurrent approvals of the SAME slot
      -- must never both land, even when total bed capacity allows both beds —
      -- this is the identical serialized-write + fresh-snapshot decision as
      -- the bed count above, keyed on slot instead of raw headcount. Gated on
      -- the room still showing SOME per-resident pricing signal (room-level
      -- or any lease term) so a `residentSlot` left over from a room later
      -- switched to flat pricing can never manufacture a false conflict.
      per_resident_room := (room->>'residentPricing' = 'per_resident')
        or exists (
          select 1 from jsonb_each(coalesce(room->'termPricing', '{}'::jsonb)) as tp(k, v)
          where v->>'residentPricing' = 'per_resident'
        );
      if per_resident_room then
        select array_agg(distinct (p->>'slot')::int) into slot_list
          from jsonb_array_elements(normalized) p
          where p->>'room' = room->>'id' and p->>'slot' is not null;
        if slot_list is not null then
          foreach slot_no in array slot_list loop
            with spans as (
              select greatest((p->>'start')::date, coalesce(candidate_start, (now() at time zone 'America/Los_Angeles')::date)) s,
                     least((p->>'end')::date, coalesce(candidate_end, 'infinity'::date)) e
              from jsonb_array_elements(normalized) p
              where p->>'room' = room->>'id' and (p->>'slot')::int = slot_no
            ), events as (
              select s d, 1 n from spans where s <= e
              union all
              select e + 1, -1 from spans where isfinite(e) and s <= e
            ), deltas as (select d, sum(n) n from events group by d),
            running as (select sum(n) over(order by d rows unbounded preceding) n from deltas)
            select coalesce(max(n), 0) into slot_max from running;
            if slot_max > 1 then
              raise exception using errcode = 'P4001', message = 'That resident slot is already held for this room.';
            end if;
          end loop;
        end if;
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
