-- Airbnb money on a channel stay: what the guest pays per night, what Airbnb pays the host out, and when.
--
-- Airbnb's calendar feed carries no money. The manager types it on the booking record, or it arrives from
-- Airbnb's own "Reservation confirmed" / payout emails to the workspace work email (source = 'airbnb_email').
-- The payout is projected as an "Airbnb" row in Incoming payments; it is never a resident charge.
--
-- Same table, same posture as 20261009190000_channel_stay_details.sql: RLS on, no client policy or grant,
-- service-role routes only. Additive and idempotent; safe to re-run.

alter table public.channel_stay_details
  add column if not exists payout_cents integer,
  add column if not exists nightly_cents integer,
  add column if not exists currency text default 'USD',
  add column if not exists paid_at timestamptz,
  add column if not exists source text default 'manual',
  add column if not exists guest_phone text,
  add column if not exists check_in date,
  add column if not exists check_out date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channel_stay_details_money_check') then
    alter table public.channel_stay_details
      add constraint channel_stay_details_money_check
      check (
        (payout_cents is null or payout_cents between 0 and 100000000)
        and (nightly_cents is null or nightly_cents between 0 and 100000000)
        and (guest_phone is null or char_length(guest_phone) <= 40)
      );
  end if;
end $$;
