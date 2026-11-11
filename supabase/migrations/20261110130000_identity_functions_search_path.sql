-- SECURITY DEFINER identity functions pin `pg_temp` last so a session cannot shadow a
-- table or function with a temporary object. Only the live signatures exist: the
-- five-argument apply_resident_identity_event was dropped by 20261030123000.
alter function public.apply_resident_identity_event(text, text, uuid, text, timestamptz, text)
  set search_path = public, pg_temp;
alter function public.retry_expired_resident_identity(uuid)
  set search_path = public, pg_temp;
