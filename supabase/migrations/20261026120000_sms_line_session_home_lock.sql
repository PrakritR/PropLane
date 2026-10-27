-- The PropLane line locks a texter to ONE home (and so one manager) the first time they pick or name a home.
-- Until now the session only remembered a workspace + role, so "what about the other one?" had nothing to compare
-- against. `locked_property_id` is the home (manager_property_records.id, kept as text like the other property ids on
-- the line), `locked_at` when it was set. A switch to another home is never acted on silently: the router asks
-- "Are you asking about X?" (pending_candidates / pending_asked_at carry that question) and only a yes moves the lock.
--
-- Additive and idempotent. No new table, no grant or RLS change (the table stays server-only), nothing to classify in
-- the account purge manifest. Code that runs before this migration reads and writes the session without the lock.

alter table public.sms_line_sessions
  add column if not exists locked_property_id text,
  add column if not exists locked_at timestamptz;

comment on column public.sms_line_sessions.locked_property_id is
  'The one home this phone is locked to on the PropLane line (manager_property_records.id). NULL = not locked yet.';
comment on column public.sms_line_sessions.locked_at is
  'When locked_property_id was last set (a pick, a text naming one home, or a yes to the switch question).';
