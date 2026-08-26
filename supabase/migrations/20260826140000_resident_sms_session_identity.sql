-- A verified phone can change owners. Resident SMS history must therefore be
-- keyed by the verified resident user as well as manager + phone; otherwise a
-- newly verified owner of a recycled number can inherit the prior resident's
-- agent session and prompt history.

create unique index if not exists agent_sessions_resident_sms_identity_uidx
  on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)
  where kind = 'resident_sms'
    and user_id is not null
    and vendor_phone_e164 is not null;
