-- A PropLane Service invite link is bound to the email it was sent to: redeeming it requires the signed-in
-- account's confirmed email to match, so a forwarded or leaked link (an Owner link especially) cannot be taken
-- by someone else. NULL on every ordinary invite link, which stays a bearer link exactly as before.
-- Additive and idempotent. No new table, so nothing to classify in the account purge manifest.

alter table public.manager_invite_links
  add column if not exists invitee_email text;

alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_invitee_email_lower_check,
  add constraint manager_invite_links_invitee_email_lower_check
    check (invitee_email is null or invitee_email = lower(btrim(invitee_email)));

comment on column public.manager_invite_links.invitee_email is
  'PropLane Service invite links only: the lowercase email the link was sent to. Redeem requires the redeemer''s confirmed auth email to equal it. NULL = an ordinary bearer link.';
