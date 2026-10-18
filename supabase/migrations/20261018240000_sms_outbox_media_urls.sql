-- One-number SMS: outbound MMS on the outbox (additive, idempotent).
-- The shared-line door (sendSharedLineMessage) can carry media URLs; the outbox row stores them so
-- the dispatcher hands them to the provider call. Null = a plain text, exactly as before.
alter table public.sms_outbox add column if not exists media_urls text[];
