-- Serialize short-stay holds against property occupancy revision and refuse
-- overlapping stays that exceed room capacity (guest-weighted).

create or replace function public.enforce_short_stay_room_date_block()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  prop public.manager_property_records%rowtype;
  submission jsonb;
  rooms jsonb;
  room_id text;
  capacity numeric := 1;
  guests numeric := 1;
  check_in date;
  check_out date;
  max_count bigint;
begin
  if new.record_type is distinct from 'room_date_block' then
    return new;
  end if;
  if coalesce(new.row_data->>'bookingStatus', '') not in ('hold', 'confirmed') then
    return new;
  end if;
  room_id := nullif(btrim(new.row_data->>'roomId'), '');
  check_in := (new.row_data->>'checkIn')::date;
  check_out := (new.row_data->>'checkOut')::date;
  if room_id is null or check_in is null or check_out is null or check_out <= check_in then
    raise exception using errcode = '23514', message = 'Short-stay dates are invalid.';
  end if;
  begin
    guests := greatest(1, coalesce(nullif(btrim(new.row_data#>>'{stayDetails,guests}'), '')::numeric, 1));
  exception when invalid_text_representation or numeric_value_out_of_range then
    guests := 1;
  end if;

  update public.manager_property_records p
    set occupancy_revision = p.occupancy_revision + 1
    where p.id = new.property_id and p.manager_user_id = new.manager_user_id
    returning p.* into prop;
  if not found then
    raise exception using errcode = '23514', message = 'Assigned property is unavailable to this owner.';
  end if;

  submission := coalesce(prop.property_data->'listingSubmission', prop.row_data->'submission');
  rooms := coalesce(submission->'rooms', '[]'::jsonb);
  select nullif(btrim(r->>'occupancyCapacity'), '')::numeric into capacity
    from jsonb_array_elements(rooms) r where r->>'id' = room_id limit 1;
  if capacity is null or capacity < 1 or capacity > 20 then capacity := 1; end if;

  with spans as (
    select check_in s, check_out e, guests w
    union all
    select (b.row_data->>'checkIn')::date,
           (b.row_data->>'checkOut')::date,
           greatest(1, coalesce(nullif(btrim(b.row_data#>>'{stayDetails,guests}'), '')::numeric, 1))
      from public.portal_schedule_records b
      where b.manager_user_id = new.manager_user_id
        and b.property_id = new.property_id
        and b.record_type = 'room_date_block'
        and b.id is distinct from new.id
        and coalesce(b.row_data->>'bookingStatus', '') in ('hold', 'confirmed')
        and b.row_data->>'roomId' = room_id
  ), events as (
    select s d, w n from spans where s < e
    union all
    select e, -w from spans where s < e
  ), deltas as (select d, sum(n) n from events group by d),
  running as (select sum(n) over (order by d rows unbounded preceding) peak from deltas)
  select coalesce(max(peak), 0) into max_count from running;

  if max_count > capacity then
    raise exception using errcode = 'P4001', message = 'Those dates are no longer available.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_short_stay_room_date_block on public.portal_schedule_records;
create trigger enforce_short_stay_room_date_block
  before insert or update on public.portal_schedule_records
  for each row execute function public.enforce_short_stay_room_date_block();
