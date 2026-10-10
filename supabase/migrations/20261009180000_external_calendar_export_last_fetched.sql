-- When a channel (Airbnb) last fetched PropLane's per-room export feed. Stamped
-- best-effort by the export route; shown as "Airbnb checked PropLane".
alter table public.external_calendar_connections
  add column if not exists export_last_fetched_at timestamptz;
