-- Exact check-in and check-out times (bookings-times-1018). Additive and idempotent.
--
-- A stay's DATES stay authoritative (row_data.checkIn / checkOut, checkout
-- exclusive). Its TIMES ride beside them as property wall-clock "HH:MM":
-- row_data.checkInTime / checkOutTime, with the real instants in starts_at /
-- ends_at. An imported channel stay keeps the property defaults and stores a
-- manager override on channel_stay_details.check_in_at / check_out_at.
--
-- Time zone note: the property zone is derived from its ZIP in application code
-- (propertyTimeZoneForZip) and is never stored. Every live house is Pacific, so
-- the backfill below uses America/Los_Angeles. A property in another zone gets
-- its instants corrected the next time any writer saves the stay.

-- 1. A valid 24h "H:MM" / "HH:MM[:SS]" as a time, else the fallback.
create or replace function public.stay_wall_time(raw text, fallback time)
returns time language sql immutable set search_path = '' as $$
  select case
    when btrim(coalesce(raw, '')) ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      then btrim(raw)::time
    else fallback
  end;
$$;

-- 2. Channel stays: a manager override of the standard times.
alter table public.channel_stay_details
  add column if not exists check_in_at timestamptz,
  add column if not exists check_out_at timestamptz;

-- 3. The capacity sweep, time-aware. Everything but the sweep is the previous
--    body (20261003153000): the skips, the 23514 checks, the occupancy_revision
--    bump, the capacity source, the guests weight and the P4001 message.
--    Each stay's interval is [checkIn + checkInTime, checkOut + checkOutTime) on
--    the property's wall clock (timestamp without time zone: one property, one
--    zone), the times read from the row, else the property's stayTimes, else
--    15:00 / 11:00. A stay on default times compares exactly as the date sweep
--    did, and an 11:00 out against a 15:00 in on one day is not a conflict.
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
  default_in time;
  default_out time;
  new_start timestamp;
  new_end timestamp;
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
  end;

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

  default_in := public.stay_wall_time(submission#>>'{stayTimes,checkInTime}', time '15:00');
  default_out := public.stay_wall_time(submission#>>'{stayTimes,checkOutTime}', time '11:00');
  new_start := check_in + public.stay_wall_time(
    coalesce(new.row_data->>'checkInTime', new.row_data#>>'{stayDetails,earlyCheckIn}'), default_in);
  new_end := check_out + public.stay_wall_time(
    coalesce(new.row_data->>'checkOutTime', new.row_data#>>'{stayDetails,lateCheckOut}'), default_out);

  with spans as (
    select new_start s, new_end e, guests w
    union all
    select (b.row_data->>'checkIn')::date
             + public.stay_wall_time(
                 coalesce(b.row_data->>'checkInTime', b.row_data#>>'{stayDetails,earlyCheckIn}'), default_in),
           (b.row_data->>'checkOut')::date
             + public.stay_wall_time(
                 coalesce(b.row_data->>'checkOutTime', b.row_data#>>'{stayDetails,lateCheckOut}'), default_out),
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

-- 4. Backfill every stay that has no time of its own: legacy sheet times, else
--    the property's stayTimes, else 15:00 / 11:00; then the instants. The
--    capacity trigger is paused for the backfill (it must neither bump the
--    occupancy revision nor re-judge historical overlaps) and restored after.
alter table public.portal_schedule_records disable trigger enforce_short_stay_room_date_block;

do $$
declare
  r record;
  submission jsonb;
  in_time time;
  out_time time;
  in_date date;
  out_date date;
begin
  for r in
    select b.id, b.manager_user_id, b.property_id, b.row_data
      from public.portal_schedule_records b
      where b.record_type in ('room_date_block', 'cancelled_room_date_block')
        and nullif(btrim(coalesce(b.row_data->>'checkInTime', '')), '') is null
  loop
    begin
      if coalesce(r.row_data->>'checkIn', '') !~ '^\d{4}-\d{2}-\d{2}$'
         or coalesce(r.row_data->>'checkOut', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        continue;
      end if;
      in_date := (r.row_data->>'checkIn')::date;
      out_date := (r.row_data->>'checkOut')::date;
      select coalesce(p.property_data->'listingSubmission', p.row_data->'submission')
        into submission
        from public.manager_property_records p
        where p.id = r.property_id;
      in_time := public.stay_wall_time(
        r.row_data#>>'{stayDetails,earlyCheckIn}',
        public.stay_wall_time(submission#>>'{stayTimes,checkInTime}', time '15:00'));
      out_time := public.stay_wall_time(
        r.row_data#>>'{stayDetails,lateCheckOut}',
        public.stay_wall_time(submission#>>'{stayTimes,checkOutTime}', time '11:00'));
      update public.portal_schedule_records
        set row_data = r.row_data
              || jsonb_build_object(
                   'checkInTime', to_char(in_time, 'HH24:MI'),
                   'checkOutTime', to_char(out_time, 'HH24:MI')),
            starts_at = (in_date + in_time) at time zone 'America/Los_Angeles',
            ends_at = (out_date + out_time) at time zone 'America/Los_Angeles'
        where id = r.id and manager_user_id is not distinct from r.manager_user_id;
    exception when others then
      -- A row with an impossible date (2026-02-30) is skipped, not fatal.
      continue;
    end;
  end loop;
end;
$$;

alter table public.portal_schedule_records enable trigger enforce_short_stay_room_date_block;
