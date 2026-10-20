-- A paid plan whose provider could not answer backs off instead of holding the head of the reconcile queue.
--
-- The daily sweep takes the least recently checked rows. A failed row used to be left unstamped so it stayed at the
-- front - which means a provider outage, or a batch of rows it always fails on, could fill the whole budget with the
-- same rows run after run, and the tail (where an unreconciled cancellation hides) was never reached. Every outcome
-- is now stamped, and a failure also records when the provider may be asked again.
--
-- Idempotent; additive.

alter table public.manager_purchases
  add column if not exists plan_reconcile_retry_at timestamptz;
