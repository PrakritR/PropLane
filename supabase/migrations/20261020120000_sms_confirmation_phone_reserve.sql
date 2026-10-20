-- Per-phone confirmation-code budget, made atomic (security review, Oct 20).
--
-- The cap of ten wrong codes per phone per 24 hours was a read (count recent failures) followed, later, by a separate
-- insert on a wrong guess. Many parallel guesses all read "under the cap" before any insert landed, so a burst could
-- walk past it. This function does the count and the reservation in ONE transaction under a per-phone advisory lock:
-- it counts the recent rows and, if the phone is still under the cap, inserts the row for THIS guess and returns its
-- id (locked = false); at or over the cap it inserts nothing and returns locked = true. The caller reserves BEFORE it
-- compares the code, deletes the returned row when the code was right, and treats any error as "unavailable" (fail
-- closed), so a failed write can never be an unrecorded guess.
--
-- Idempotent; additive. Service role only; the table itself stays unreadable to clients.

create or replace function public.sms_confirmation_phone_reserve(
  p_phone_hash text,
  p_cap integer,
  p_window_seconds integer,
  p_now timestamptz default now()
) returns table (locked boolean, failure_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_id uuid;
begin
  if p_phone_hash is null or length(p_phone_hash) = 0 or p_cap is null or p_cap < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid_arguments';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms-confirm-phone:' || p_phone_hash, 0));
  select count(*) into v_count
    from public.sms_confirmation_failures
    where phone_hash = p_phone_hash
      and failed_at >= coalesce(p_now, now()) - make_interval(secs => p_window_seconds);
  if v_count >= p_cap then
    return query select true, null::uuid;
    return;
  end if;
  insert into public.sms_confirmation_failures (phone_hash, failed_at)
    values (p_phone_hash, coalesce(p_now, now()))
    returning id into v_id;
  return query select false, v_id;
end;
$$;

revoke all on function public.sms_confirmation_phone_reserve(text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.sms_confirmation_phone_reserve(text, integer, integer, timestamptz) to service_role;
