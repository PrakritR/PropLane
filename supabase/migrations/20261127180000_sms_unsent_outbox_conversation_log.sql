-- Texts the provider refused with no Message SID (Twilio suspended PropLane's account on Nov 25; every send since answers
-- error 20003) are `sms_outbox.status = 'unknown'` and were never recorded in Communication. The dispatcher now records such
-- a text under its outbox id (`outbox:<id>`) right away, and `reconcileSubmittedSmsConversationLogs` (the sms-outbox cron)
-- repairs any it missed. This makes the rows already stuck since the suspension due for that repair, once.
--
-- Data only. It changes no send status and sends nothing: the repair writes the conversation record (or, for a mirror
-- delivery to the manager's own phone, the PropLane Assistant copy) and never calls Twilio. Rows without a sender snapshot
-- (`provider_from_phone`) stay out, so no record ever names a sender the text was not meant to leave from.
update public.sms_outbox
   set conversation_log_next_attempt_at = now(),
       updated_at = now()
 where status = 'unknown'
   and blocked_reason = 'provider_submission_outcome_unknown'
   and provider_message_sid is null
   and provider_from_phone is not null
   and conversation_log_status in ('pending', 'failed')
   and conversation_log_next_attempt_at is null
   and created_at >= timestamptz '2026-11-25 00:00:00+00';
