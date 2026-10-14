-- Guest stays: the resident portal asks "does this login own a short stay?" on every page it renders
-- (`residentHasStays`, what unlocks the Stays section), and the Stays list reads the same rows. Both
-- filter `portal_schedule_records` on `row_data->>'residentUserId'`, which had no index. Additive and
-- idempotent; it changes no row and no constraint.
--
-- The `channel_booking` domain and the `tours` category the new `short_stay_confirmed|declined|expired`
-- action events use are already admitted by the domain allow-list (20261013000000) and the category
-- allow-list (20261013060000), and `action_events.event` has no check, so no allow-list is widened here
-- (tests/unit/short-stay-guest-events.test.ts pins both lists).
create index if not exists portal_schedule_records_guest_stay_idx
  on public.portal_schedule_records ((row_data->>'residentUserId'))
  where record_type in ('room_date_block', 'cancelled_room_date_block');
