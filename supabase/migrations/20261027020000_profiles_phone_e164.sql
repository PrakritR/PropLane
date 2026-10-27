-- `profiles.phone` is E.164 TEXT everywhere it is written (`phone_auth_bind`, `provisionResidentAccountByEmail`), and
-- every exact-match reader asks for it that way: `findResidentProfileByPhone`, the manager-by-personal-phone lookup in
-- the leasing bot, and the guest short-stay account match. A numeric column cannot hold the leading `+`, so the rows
-- 20261027010000 converted read back as bare digits and stopped matching those readers (numeric equality coerced both
-- sides of `= '+1...'`; plain text equality does not).
-- Normalize them through the same function `phone_auth_owners` already reads with. Digits-only values only, so a
-- hand-typed contact string is left exactly as it was, and a value already in E.164 is untouched - idempotent, and a
-- no-op where no row ever drifted. The same digits for the same account is a SHAPE fix, not a new identity, so it runs
-- under the bind flag `guard_verified_phone_change` already exempts; without it the guard would abort the push in
-- shared line mode.
do $$
begin
  perform set_config('proplane.phone_auth_binding', 'yes', true);
  update public.profiles
  set phone = public.phone_auth_e164(phone)
  where phone is not null
    and phone not like '+%'
    and phone ~ '^[0-9]{10,15}$';
end $$;
