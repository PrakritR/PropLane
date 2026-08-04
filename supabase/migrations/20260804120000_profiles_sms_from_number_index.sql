-- Work-number owner lookups run on the SMS hot paths: the paid-feature gate in
-- `sendSms` resolves the owner of every outbound `from`, and the Twilio inbound
-- webhook resolves the manager who owns the number that was texted. Both filter
-- `profiles.sms_from_number` against a handful of storage formats, which was a
-- sequential scan over every profile. Partial (most profiles have no work
-- number) and idempotent, per the repo's migration rules.

create index if not exists profiles_sms_from_number_idx
  on public.profiles (sms_from_number)
  where sms_from_number is not null;
