-- Calendar blocks and coordination reservations share the same linked-vendor lock.
-- Explicit per-job vendor/resident windows replace recurring-open requirements;
-- dated blocks and vendor calendar events remain hard conflicts.
create or replace function public.vendor_coordination_busy_rule_overlaps(
  p_rule public.vendor_availability_rules,
  p_starts_at timestamptz,
  p_ends_at timestamptz
) returns boolean language sql stable as $$
  select p_rule.kind in ('block','event') and exists (
    select 1
    from generate_series(date_trunc('minute', p_starts_at), p_ends_at, interval '1 minute') as sample(at)
    cross join lateral (
      select greatest(sample.at, p_starts_at) at time zone 'America/Los_Angeles' as local_at
    ) as pacific
    where greatest(sample.at, p_starts_at) < p_ends_at
      and pacific.local_at::date = p_rule.specific_date
      and (extract(hour from pacific.local_at)::integer * 60 + extract(minute from pacific.local_at)::integer)
        >= p_rule.start_minute
      and (extract(hour from pacific.local_at)::integer * 60 + extract(minute from pacific.local_at)::integer)
        < p_rule.end_minute
  );
$$;

create or replace function public.guard_vendor_coordination_reservation_calendar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'active' or new.vendor_user_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || new.vendor_user_id::text, 0));
  if exists (select 1 from public.vendor_availability_rules rule
    where rule.vendor_user_id = new.vendor_user_id and rule.kind in ('block','event')
      and public.vendor_coordination_busy_rule_overlaps(rule, new.starts_at, new.ends_at)) then
    raise exception 'vendor calendar block conflicts with reservation';
  end if;
  return new;
end $$;
drop trigger if exists guard_vendor_coordination_reservation_calendar on public.vendor_coordination_reservations;
create trigger guard_vendor_coordination_reservation_calendar
  before insert or update of starts_at, ends_at, status, vendor_user_id
  on public.vendor_coordination_reservations
  for each row execute function public.guard_vendor_coordination_reservation_calendar();

create or replace function public.guard_vendor_calendar_against_coordination()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_first uuid; v_second uuid;
begin
  if tg_op = 'UPDATE' then
    if old.vendor_user_id is distinct from new.vendor_user_id then
      v_first := least(old.vendor_user_id,new.vendor_user_id);
      v_second := greatest(old.vendor_user_id,new.vendor_user_id);
      perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || v_first::text,0));
      perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || v_second::text,0));
    else
      perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || new.vendor_user_id::text,0));
    end if;
  elsif tg_op = 'DELETE' then
    perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || old.vendor_user_id::text,0));
  else
    perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || new.vendor_user_id::text,0));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.kind not in ('block','event') then return new; end if;
  if exists (select 1 from public.vendor_coordination_reservations reservation
    left join public.manager_vendor_records directory on directory.id = reservation.vendor_directory_id
    where reservation.status = 'active'
      and (reservation.vendor_user_id = new.vendor_user_id or directory.vendor_user_id = new.vendor_user_id)
      and public.vendor_coordination_busy_rule_overlaps(new, reservation.starts_at, reservation.ends_at)) then
    raise exception 'vendor calendar block conflicts with booked visit';
  end if;
  return new;
end $$;
drop trigger if exists guard_vendor_calendar_against_coordination on public.vendor_availability_rules;
create trigger guard_vendor_calendar_against_coordination
  before insert or update or delete on public.vendor_availability_rules
  for each row execute function public.guard_vendor_calendar_against_coordination();
