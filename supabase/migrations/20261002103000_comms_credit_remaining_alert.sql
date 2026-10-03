-- Remaining-credit alerts are independent of the legacy monthly-spend budget.
alter table public.manager_comms_billing_accounts
  add column if not exists credit_alert_remaining_cents integer,
  add column if not exists credit_alert_notified_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'comms_credit_alert_remaining_range') then
    alter table public.manager_comms_billing_accounts add constraint comms_credit_alert_remaining_range
      check (credit_alert_remaining_cents is null or credit_alert_remaining_cents between 0 and 1000000);
  end if;
end $$;
