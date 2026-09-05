-- Manager voice agent sessions (phone-call turns, separate from manager_sms).
create unique index if not exists agent_sessions_manager_voice_identity_uidx
  on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)
  where kind = 'manager_voice';
