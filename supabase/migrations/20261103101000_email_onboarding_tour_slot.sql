-- A prospect who picks a tour time BEFORE having an account carries that pick through the emailed
-- verification link on the server-decided handoff (property_id + listing_room_id already live here).
-- The pick is only a prefill for /resident/tour/schedule: booking re-checks the slot on the server.
alter table public.email_onboarding_handoffs
  add column if not exists tour_slot_key text;
alter table public.email_onboarding_handoffs
  drop constraint if exists email_onboarding_handoffs_tour_slot_key_check;
alter table public.email_onboarding_handoffs
  add constraint email_onboarding_handoffs_tour_slot_key_check
  check (tour_slot_key is null or tour_slot_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]{1,3}$');
