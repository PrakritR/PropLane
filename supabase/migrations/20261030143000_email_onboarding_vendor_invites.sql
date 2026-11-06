-- A vendor invite is a relationship reference, never proof of mailbox ownership.
alter table public.email_onboarding_handoffs
  add column if not exists vendor_invite_id uuid references public.vendor_invites(id) on delete cascade;
alter table public.email_onboarding_handoffs drop constraint if exists email_onboarding_handoffs_intent_check;
alter table public.email_onboarding_handoffs add constraint email_onboarding_handoffs_intent_check
  check (intent in ('generic','resident','manager','vendor','tour','manager_paid','application','vendor_invite'));
