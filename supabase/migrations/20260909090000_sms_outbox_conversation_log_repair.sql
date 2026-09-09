-- Provider submission and Communication logging are separate durable effects.
-- A failed log must be repairable without ever sending the provider message again.
alter table public.sms_outbox
  add column if not exists conversation_log_status text not null default 'pending'
    check (conversation_log_status in ('pending', 'persisted', 'failed', 'blocked')),
  add column if not exists conversation_log_attempts integer not null default 0
    check (conversation_log_attempts >= 0),
  add column if not exists conversation_log_next_attempt_at timestamptz,
  add column if not exists conversation_log_last_error text,
  add column if not exists provider_from_phone text;

create index if not exists sms_outbox_conversation_log_repair_idx
  on public.sms_outbox (conversation_log_next_attempt_at, updated_at)
  where conversation_log_status in ('pending', 'failed')
    and provider_message_sid is not null
    and provider_from_phone is not null
    and status in ('submitted', 'sent', 'delivered', 'failed');

-- Only rows that already contain the actual submitted sender can be repaired.
-- Older rows lack that immutable snapshot, so automatic repair deliberately
-- excludes them rather than inventing a phone pair from current configuration.
-- Replaying an eligible known SID is safe because manager_sms_messages enforces
-- one row per provider SID.
update public.sms_outbox
set conversation_log_status = 'failed',
    conversation_log_next_attempt_at = now(),
    conversation_log_last_error = 'legacy_projection_unverified'
where conversation_log_status = 'pending'
  and provider_message_sid is not null
  and provider_from_phone is not null
  and status in ('submitted', 'sent', 'delivered', 'failed');

comment on column public.sms_outbox.conversation_log_status is
  'Communication audit projection state. Repair writes manager_sms_messages only; it never resends provider SMS.';
