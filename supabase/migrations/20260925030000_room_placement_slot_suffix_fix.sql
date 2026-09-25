-- Bug: approving ANY application whose room choice carries the resident-slot
-- suffix ("<propertyId>::<roomId>::r<N>", written by
-- src/lib/rental-application/data.ts's roomChoiceValue()/LISTING_ROOM_SLOT_SUFFIX
-- whenever the applicant picks a specific bed in a per-resident-priced room)
-- always failed with "Could not persist the application: Assigned room no
-- longer exists." even though the room genuinely exists.
--
-- Root cause: room_placement_room() extracted the room id with
-- `substring(choice from position('::' in choice) + 2)`, which takes
-- everything after the FIRST "::" separator. For a plain "propertyId::roomId"
-- choice that is correct, but for "propertyId::roomId::r1" it returns
-- "roomId::r1" — a string that can never match a real room id — so it fell
-- through to the by-name fallback (20260914120000_room_placement_name_fallback.sql),
-- which also fails on a fresh application because manualResidentDetails.roomNumber
-- is not yet set, and finally raised the false "no longer exists" error.
--
-- The application/JS side (parseRoomChoiceValue in
-- src/lib/rental-application/data.ts) already strips this suffix correctly
-- with the regex /::r(\d+)$/ before resolving the room, which is why the
-- browser's own pre-flight checks passed and the failure only ever surfaced
-- once the write reached this database trigger.
--
-- Fix: strip the same trailing "::r<digits>" suffix here before splitting on
-- "::", so the extracted room id matches what the JS layer already resolves.
create or replace function public.room_placement_room(p_row jsonb, p_rooms jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare choice text; canonical text; rid text; matches text[]; by_name text[];
begin
  choice := coalesce(nullif(btrim(p_row->>'assignedRoomChoice'), ''),
    nullif(btrim(p_row#>>'{application,roomChoice1}'), ''));
  if choice = public.room_placement_property(p_row) then return '__whole_property__'; end if;
  -- Mirror parseRoomChoiceValue()'s LISTING_ROOM_SLOT_SUFFIX: a trailing
  -- "::r<N>" names the 1-based resident slot and is never part of the room id
  -- -- but ONLY when it is a genuine third segment ("propertyId::roomId::r1").
  -- A plain two-segment "propertyId::roomId" must never be stripped just
  -- because the room id itself happens to look like "r2" -- requiring a
  -- SECOND "::" before the trailing "::r<N>" is what tells the two apart.
  canonical := case when choice ~ '::.*::r[0-9]+$'
    then regexp_replace(choice, '::r[0-9]+$', '') else choice end;
  if position('::' in canonical) > 0 then
    -- Reject a structured placement that names a different property.
    if split_part(canonical, '::', 1) is distinct from public.room_placement_property(p_row) then
      raise exception using errcode = '23514', message = 'Room does not belong to the assigned property.';
    end if;
    rid := substring(canonical from position('::' in canonical) + 2);
    if exists(select 1 from jsonb_array_elements(p_rooms) room where room->>'id' = rid) then return rid; end if;
    select array_agg(room->>'id') into by_name from jsonb_array_elements(p_rooms) room
      where lower(btrim(room->>'name')) = lower(nullif(btrim(p_row#>>'{manualResidentDetails,roomNumber}'), ''));
    if array_length(by_name, 1) = 1 then return by_name[1]; end if;
    raise exception using errcode = '23514', message = 'Assigned room no longer exists.';
  end if;
  select array_agg(room->>'id') into matches from jsonb_array_elements(p_rooms) room
    where room->>'id' = canonical or lower(btrim(room->>'name')) = lower(coalesce(nullif(btrim(p_row#>>'{manualResidentDetails,roomNumber}'), ''), canonical));
  if array_length(matches, 1) = 1 then return matches[1]; end if;
  raise exception using errcode = '23514', message = 'Assign a valid room before approving this application.';
end;
$$;
