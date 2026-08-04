-- A manager can now answer an inbound-text notification email and have that
-- reply sent as an SMS from their work number. Those rows are marked
-- `email_reply` rather than `work_number` so the thread can show a reply that
-- did NOT originate in the portal — the one visible signal a manager has if
-- someone ever spoofs a reply into their conversation.
--
-- Idempotent: the CHECK is dropped by its auto-generated name and re-added.

alter table public.manager_sms_messages
  drop constraint if exists manager_sms_messages_source_check;

alter table public.manager_sms_messages
  add constraint manager_sms_messages_source_check
  check (source in ('work_number', 'relay', 'automated', 'email_reply'));
