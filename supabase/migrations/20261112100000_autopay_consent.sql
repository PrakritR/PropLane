-- Autopay consent. A saved payment method never authorizes a debit by itself: autopay charges a method only
-- after the resident explicitly agreed to it. The agreement is recorded on the enrollment row (when, for which
-- Stripe payment method, which wording), and the daily run charges only a row whose consent covers the method
-- it is about to use. Changing the method needs a new consent, which the settings route asks for.
--
-- Additive and idempotent. Rows already enabled before this migration were enrolled through the toggle the
-- resident turned on themselves; they are backfilled once as `legacy-enrollment` for their current method so
-- nobody's autopay stops on deploy. A row with no method, or one that is off, stays without consent.

alter table public.resident_autopay_settings
  add column if not exists consent_at timestamptz,
  add column if not exists consent_payment_method_id text,
  add column if not exists consent_version text;

update public.resident_autopay_settings
   set consent_at = coalesce(updated_at, now()),
       consent_payment_method_id = payment_method_id,
       consent_version = 'legacy-enrollment'
 where enabled = true
   and payment_method_id is not null
   and consent_at is null;

comment on column public.resident_autopay_settings.consent_at is
  'When the resident explicitly authorized autopay on consent_payment_method_id. Null = never authorized: the cron never charges the row.';
comment on column public.resident_autopay_settings.consent_payment_method_id is
  'The Stripe payment method the resident authorized for autopay. Autopay charges payment_method_id only while it equals this.';
comment on column public.resident_autopay_settings.consent_version is
  'The authorization wording version the resident accepted (AUTOPAY_CONSENT_VERSION), or legacy-enrollment for rows enrolled before consent was recorded.';
