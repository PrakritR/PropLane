-- PLAN-0920-1400: Extra usage buys a typed whole-dollar amount ($5-$500),
-- not one of four fixed packs. Relax the check constraint that pinned
-- credit_cents to the old pack set; the application-layer bound lives in
-- isValidCommsCreditAmountCents (src/lib/comms-billing/credit-packs.ts) and
-- is enforced identically at checkout creation and webhook fulfillment.
alter table public.manager_comms_credit_purchases
  drop constraint if exists manager_comms_credit_purchases_credit_cents_check;
alter table public.manager_comms_credit_purchases
  add constraint manager_comms_credit_purchases_credit_cents_check
  check (credit_cents >= 500 and credit_cents <= 50000 and credit_cents % 100 = 0);
