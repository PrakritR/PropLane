-- W24 (on/smsvendor): the PropLane-line chat history of one phone is ONE agent session per (service owner, phone).
-- The vendor flow (src/lib/one-number/vendor-jobs/history.server.ts) finds-or-creates it; this partial unique index
-- makes two concurrent first texts end at the same row. Additive and idempotent; no new table.
create unique index if not exists agent_sessions_vendor_line_uidx
  on public.agent_sessions (landlord_id, vendor_phone_e164)
  where kind = 'vendor_line_sms' and vendor_phone_e164 is not null;

-- The carry-over copy made when the person takes their own PropLane Number (copyPropLaneLineHistory) is keyed the same
-- way under the NEW owner, so a replay cannot create a second carry-over session.
create unique index if not exists agent_sessions_line_carryover_uidx
  on public.agent_sessions (landlord_id, vendor_phone_e164)
  where kind = 'propline_carryover' and vendor_phone_e164 is not null;

-- A stranger on the PropLane line has no account: like a prospect (leasing_sms), the session is keyed on the phone. The
-- identity check names the kinds that may omit user_id; restate it with vendor_line_sms added, nothing else changed.
alter table public.agent_sessions drop constraint if exists agent_sessions_directory_identity_check;
alter table public.agent_sessions add constraint agent_sessions_directory_identity_check check (
  user_id is not null
  or (kind = 'vendor_work_order' and vendor_directory_id is not null)
  or (kind = any (array['leasing_sms', 'leasing_email', 'resident_email', 'vendor_line_sms'])
      and landlord_id is not null and nullif(btrim(vendor_phone_e164), '') is not null)
);
