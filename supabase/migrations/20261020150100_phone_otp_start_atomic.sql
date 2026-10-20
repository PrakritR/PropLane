-- ---------------------------------------------------------------------------------------------
-- phone_otp_start: count + retire + insert for a phone code, in ONE statement under a per-phone lock.
--
-- `requestPhoneOtp` ran the three as separate round trips, so two concurrent `send` requests for the same phone both
-- read the same count and both passed the 3-per-hour budget (the bound phone could be texted up to the route's own
-- allowance instead), and when both retires landed before both inserts, TWO challenges were left unconsumed - so
-- after the newest was redeemed, the older one became "newest unconsumed" and verified too, defeating "only the
-- newest code can work".
--
-- This is the `phone_auth_start` shape for the purposes `phone_otp_challenges` serves without an auth user
-- (link_unlock, public_bind, sms_signup, service_manager) as well as the auth ones. Same caps as
-- `SHARED_LINE_OTP_RULES`: 3 sends per phone per hour per purpose, 8 across every purpose, and no text at all to a
-- phone that has burned this purpose's 10 failed codes in 24 hours. `subject_id` is part of the retire key: a code
-- for one link never retires another's.
-- Additive: new function only.
-- ---------------------------------------------------------------------------------------------
create or replace function public.phone_otp_start(
  p_id uuid, p_phone_key text, p_purpose text, p_subject text, p_code_hash text, p_ttl_minutes integer,
  p_now timestamptz default now()
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := coalesce(p_now, now());
begin
  if p_phone_key !~ '^[0-9]{10}$' or p_purpose is null or p_code_hash is null
     or p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 60 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-otp:' || p_phone_key, 0));
  -- This purpose's own hourly allowance, then the phone's ceiling across every purpose.
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and purpose = p_purpose and created_at > v_now - interval '1 hour') >= 3 then
    return false;
  end if;
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and created_at > v_now - interval '1 hour') >= 8 then
    return false;
  end if;
  -- Locked phone: ten wrong codes for THIS purpose in 24 hours. No text is sent to it.
  if public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= 10 then return false; end if;
  -- Only the newest code for this phone + purpose + subject can work.
  update public.phone_otp_challenges set consumed_at = v_now
    where phone_key = p_phone_key and purpose = p_purpose
      and subject_id is not distinct from p_subject and consumed_at is null;
  insert into public.phone_otp_challenges(id, phone_key, purpose, subject_id, code_hash, attempts, created_at, expires_at)
    values (p_id, p_phone_key, p_purpose, p_subject, p_code_hash, 0, v_now, v_now + make_interval(mins => p_ttl_minutes));
  return true;
end $$;

revoke all on function public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz) to service_role;
