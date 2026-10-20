-- ---------------------------------------------------------------------------------------------
-- phone_otp_start: the three caps come from the application, not a second copy in SQL.
--
-- 20261020150100 hardcoded 3 / 8 / 10 while `SHARED_LINE_OTP_RULES` (plus `PHONE_LIFETIME_FAILED_CODE_CAP`) kept
-- the TypeScript copies. They agreed, but editing the constant would silently not change the enforced limit -
-- and the constant is what every other code path reads. The caps are parameters now, so there is ONE source.
--
-- The old 7-argument signature is dropped rather than left as an overload: two functions whose names agree and
-- whose caps do not is exactly the drift this removes.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz);

create or replace function public.phone_otp_start(
  p_id uuid, p_phone_key text, p_purpose text, p_subject text, p_code_hash text, p_ttl_minutes integer,
  p_max_per_purpose integer, p_max_per_phone integer, p_max_failed integer,
  p_now timestamptz default now()
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := coalesce(p_now, now());
begin
  if p_phone_key !~ '^[0-9]{10}$' or p_purpose is null or p_code_hash is null
     or p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 60 then
    return false;
  end if;
  -- A missing or nonsensical cap is not "no cap": it refuses.
  if p_max_per_purpose is null or p_max_per_purpose < 1 or p_max_per_phone is null or p_max_per_phone < 1
     or p_max_failed is null or p_max_failed < 1 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-otp:' || p_phone_key, 0));
  -- This purpose's own hourly allowance, then the phone's ceiling across every purpose.
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and purpose = p_purpose and created_at > v_now - interval '1 hour') >= p_max_per_purpose then
    return false;
  end if;
  if (select count(*) from public.phone_otp_challenges
        where phone_key = p_phone_key and created_at > v_now - interval '1 hour') >= p_max_per_phone then
    return false;
  end if;
  -- Locked phone: this purpose's wrong-code budget for the last 24 hours is spent. No text is sent to it.
  if public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= p_max_failed then return false; end if;
  -- Only the newest code for this phone + purpose + subject can work.
  update public.phone_otp_challenges set consumed_at = v_now
    where phone_key = p_phone_key and purpose = p_purpose
      and subject_id is not distinct from p_subject and consumed_at is null;
  insert into public.phone_otp_challenges(id, phone_key, purpose, subject_id, code_hash, attempts, created_at, expires_at)
    values (p_id, p_phone_key, p_purpose, p_subject, p_code_hash, 0, v_now, v_now + make_interval(mins => p_ttl_minutes));
  return true;
end $$;

revoke all on function public.phone_otp_start(uuid, text, text, text, text, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.phone_otp_start(uuid, text, text, text, text, integer, integer, integer, integer, timestamptz) to service_role;
