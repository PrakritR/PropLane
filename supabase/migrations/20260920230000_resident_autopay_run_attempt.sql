-- Resident autopay: track the attempt number ON the run row.
--
-- The one allowed retry used to be recognised by a "[retry] " prefix that
-- `chargeAutopay` wrote into `failure_reason` on a synchronous decline only.
-- An ACH autopay settles asynchronously, so its decline arrives days later via
-- the payment_intent.payment_failed webhook, which never carried that prefix —
-- the run then looked "never retried" forever and was re-debited every ~3
-- days. `attempt` is the counter both the cron and the webhook read: 1 is the
-- first charge, 2 is the one retry, and nothing goes past
-- `AUTOPAY_MAX_ATTEMPTS` regardless of which path recorded the failure.

alter table public.resident_autopay_runs
  add column if not exists attempt int not null default 1 check (attempt >= 1);

comment on column public.resident_autopay_runs.attempt is
  'Charge attempt this row is on: 1 = first run, 2 = the one allowed retry. The retry claim increments it in place; a failed row at the max is never retried again, whether the failure was recorded synchronously or by the webhook.';
