-- A manager-saved email address for an SMS-only contact.
--
-- The row is still keyed on (manager, phone, role); this column only records
-- the address the manager typed so a text-only thread can also be replied to
-- by email. It is NOT identity proof, verification, or consent — the same rule
-- the display label already carries. Sending still runs the normal
-- server-side resolution and consent gate.
--
-- It also carries the reverse case: an email-only conversation the manager
-- gives a phone number to gets a row here whose contact_email matches that
-- thread, which is how the SMS channel becomes available for it.

alter table public.manager_sms_contacts
  add column if not exists contact_email text check (
    contact_email is null or (char_length(trim(contact_email)) between 3 and 254)
  );

create index if not exists manager_sms_contacts_owner_email_idx
  on public.manager_sms_contacts (manager_user_id, contact_email);
