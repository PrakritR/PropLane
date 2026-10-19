-- Stay-time reminders (bookings-times-1018). Additive and idempotent.
--
-- Two guest-facing reminder kinds, timed off a stay's real check-in / check-out:
--
--   stay_arrival_guide     - 24 h before check-in: the arrival guide (door code, Wi-Fi,
--                            parking, house rules) to the guest, in their own 1:1 thread
--   stay_checkout_reminder - 08:00 on checkout day: "Checkout is at 11:00 am today"
--
-- Widens `portal_reminder_records_kind_check` by READING the live definition and appending
-- the two kinds, so a peer migration that added its own kinds is never rolled back (the
-- same pattern as the action_events.domain widening in 20261018120100). Re-running it is a
-- no-op once both kinds are present.

do $$
declare
  def text;
  vals text[];
  wanted text[] := array['stay_arrival_guide', 'stay_checkout_reminder'];
begin
  select pg_get_constraintdef(c.oid) into def
  from pg_constraint c
  where c.conname = 'portal_reminder_records_kind_check'
    and c.conrelid = 'public.portal_reminder_records'::regclass;
  if def is null then
    return;
  end if;
  select coalesce(array_agg(distinct m[1]), '{}') into vals
  from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  if wanted <@ vals then
    return;
  end if;
  vals := (select array_agg(distinct v) from unnest(vals || wanted) as v);
  execute 'alter table public.portal_reminder_records drop constraint if exists portal_reminder_records_kind_check';
  execute format(
    'alter table public.portal_reminder_records add constraint portal_reminder_records_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v)
  );
end $$;
