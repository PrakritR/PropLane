-- Resumable provider-policy conversion marker. No money or bank details change here.
alter table public.profiles add column if not exists manual_payout_policy_at timestamptz;
-- profiles remains SELECT-only for client roles; only service-role cron writes the marker.
