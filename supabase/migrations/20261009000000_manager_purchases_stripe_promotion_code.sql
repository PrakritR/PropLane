-- The promotion code a customer redeemed at Stripe Checkout (FREEFIRST, a staff-made code, ...).
--
-- `manager_purchases.promo_code` is the payment-WAIVER column: any non-empty value there is treated
-- as paid access that needs no Stripe subscription (`isWaiverGrantedManagerPurchase`). A code that
-- merely discounted a real Stripe checkout must never land there, or cancelling the subscription
-- would leave the account on paid access for free. Redeemed checkout codes go in this column instead.
alter table public.manager_purchases
  add column if not exists stripe_promotion_code text null;

comment on column public.manager_purchases.stripe_promotion_code is
  'Promotion code redeemed at Stripe Checkout, uppercase. Display/reporting only; never grants access. The waiver column is promo_code.';
