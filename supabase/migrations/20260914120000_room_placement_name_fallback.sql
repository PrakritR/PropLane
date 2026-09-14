-- A structured placement ("<propertyId>::<roomId>") whose room id is gone used
-- to raise "Assigned room no longer exists." on EVERY save of the listing —
-- the capacity guard re-checks every approved placement on each property
-- write, so one stale id (rooms re-created with new ids while four residents'
-- rows were later re-synced from an old local copy, 5259 Brooklyn, 2026-09-13)
-- locked the whole listing against edits, and the form blamed the network.
--
-- The room's NAME is still on the row (`manualResidentDetails.roomNumber`), and
-- an unstructured choice already resolves by name. Do the same here: when the
-- id is gone but exactly one room carries that name, that is the room. Only a
-- placement with neither a live id nor a unique name still raises.
create or replace function public.room_placement_room(p_row jsonb, p_rooms jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare choice text; rid text; matches text[]; by_name text[];
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
    select array_agg(room->>'id') into by_name from jsonb_array_elements(p_rooms) room
      where lower(btrim(room->>'name')) = lower(nullif(btrim(p_row#>>'{manualResidentDetails,roomNumber}'), ''));
    if array_length(by_name, 1) = 1 then return by_name[1]; end if;
    raise exception using errcode = '23514', message = 'Assigned room no longer exists.';
  end if;
  select array_agg(room->>'id') into matches from jsonb_array_elements(p_rooms) room
    where room->>'id' = choice or lower(btrim(room->>'name')) = lower(coalesce(nullif(btrim(p_row#>>'{manualResidentDetails,roomNumber}'), ''), choice));
  if array_length(matches, 1) = 1 then return matches[1]; end if;
  raise exception using errcode = '23514', message = 'Assign a valid room before approving this application.';
end;
$$;
