-- Delivery status for inbox messages: remembers which inbox message a provider id
-- (Twilio MessageSid, Resend email id) belongs to, so a status callback can find the
-- thread without scanning every inbox row. Service-role only: a provider id is not a
-- credential, but nothing in a browser has any reason to read this table. Additive only.
create table if not exists public.inbox_message_provider_refs (
  provider_id text primary key,
  thread_record_id text not null,
  message_id text not null,
  channel text not null check (channel in ('sms','email')),
  created_at timestamptz not null default now()
);
create index if not exists inbox_message_provider_refs_thread
  on public.inbox_message_provider_refs(thread_record_id);
alter table public.inbox_message_provider_refs enable row level security;
revoke all on public.inbox_message_provider_refs from public, anon, authenticated;
grant all on public.inbox_message_provider_refs to service_role;
