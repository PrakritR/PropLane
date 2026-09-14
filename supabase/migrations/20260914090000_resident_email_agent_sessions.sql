-- A resident who emails the workspace's work address gets one agent session per
-- (workspace owner, resident email), so the assistant remembers the thread.
-- vendor_phone_e164 carries the email, exactly as the leasing_email kind does;
-- the kind is what keeps it from ever colliding with an SMS session.
create unique index if not exists agent_sessions_resident_email_identity_uidx
  on public.agent_sessions (landlord_id, vendor_phone_e164)
  where kind = 'resident_email'
    and vendor_phone_e164 is not null;
