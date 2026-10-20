-- "Skip for now" cap, made atomic (security review, Oct 20).
--
-- The route read the ledger, decided, then inserted: two parallel requests both passed the 7-day / 3-lifetime check
-- and both inserted, so the cap could be beaten by racing. This function does the count and the insert in ONE
-- transaction under a per-account advisory lock, so a second request waits for the first and then sees its row.
--
-- p_enforce = false is the platform-wide send outage (sms_runtime_config.phone_send_outage): the cap is lifted but the
-- skip is still recorded. Service role only; the table itself stays unreadable to clients.
--
-- Idempotent; additive.

create or replace function public.record_phone_required_skip(
  p_user_id uuid,
  p_cooldown_seconds integer,
  p_lifetime_max integer,
  p_enforce boolean default true
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_last timestamptz;
begin
  if p_user_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('phone-required-skip:' || p_user_id::text, 0));
  if coalesce(p_enforce, true) then
    select count(*), max(created_at) into v_count, v_last
      from public.phone_required_skips
      where user_id = p_user_id;
    if v_count >= p_lifetime_max then
      return false;
    end if;
    if v_last is not null and v_last > now() - make_interval(secs => p_cooldown_seconds) then
      return false;
    end if;
  end if;
  insert into public.phone_required_skips (user_id) values (p_user_id);
  return true;
end;
$$;

revoke all on function public.record_phone_required_skip(uuid, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.record_phone_required_skip(uuid, integer, integer, boolean) to service_role;
