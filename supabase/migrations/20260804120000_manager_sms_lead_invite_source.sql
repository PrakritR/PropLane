-- `lead_invite`: a templated CTA the system sent on a manager's behalf.
--
-- Share listing / Invite to apply / Share tour (`/api/portal/send-lead-invite`,
-- body built by `buildLeadInviteSmsText`) used to log `work_number`, the same
-- source the portal composer uses for a message a manager actually typed. The
-- inbound intent router reads any non-`automated` outbound as "a manager is
-- talking" and goes silent for that thread — so sharing a listing with a
-- prospect silenced the reply the share was sent to invite, and because that
-- silence also suppresses the leasing agent, a prospect texting TOUR back got
-- nothing at all.
--
-- Splitting the tag keeps the distinction the gate actually needs: who COMPOSED
-- the message, not merely whether the bot sent it. Additive and idempotent —
-- existing rows keep their value, and nothing reads `source` as an exhaustive
-- enum (the Communication SMS surfaces render the body, not the tag).

alter table public.manager_sms_messages
  drop constraint if exists manager_sms_messages_source_check;

alter table public.manager_sms_messages
  add constraint manager_sms_messages_source_check
  check (source in ('work_number', 'relay', 'automated', 'lead_invite'));
