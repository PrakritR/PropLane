-- Incoming payments > Send reminder (vendor-portal-ia-1007).
--
-- A vendor may nudge a manager about an approved / scheduled / overdue invoice at most once
-- every 24 hours. The throttle is stored on the invoice itself so it holds across devices and
-- retries. Additive and idempotent: one nullable column, no backfill, no new grant (the
-- vendor_invoices policies and the vendor SELECT-only grant are unchanged; only the
-- /api/vendor/invoices/[id]/remind route writes this column, with the service-role client).
alter table public.vendor_invoices add column if not exists last_reminder_at timestamptz;
