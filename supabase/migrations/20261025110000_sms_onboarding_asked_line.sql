-- The one role question ("resident, vendor, looking for a place, or manage your own property?") is asked PER LINE:
-- the PropLane line asks its own, a manager's work number asks it with that workspace's name. `asked_at` alone is
-- keyed on the phone, so one line's question suppressed every other line's. This records WHICH line asked, so a
-- stranger who texts a second work number is still asked there, and the 206 never defaults someone to "searcher"
-- because a manager's number had asked them something else.
--
-- `shared` is the PropLane line itself; any other value is the E.164 work number that asked. NULL = a row written
-- before this column existed, which keeps its old behaviour (whichever line reads it treats the ask as its own).
-- Additive and idempotent. No new table, so nothing to classify in the account purge manifest.

alter table public.sms_onboarding_state
  add column if not exists asked_line text;

comment on column public.sms_onboarding_state.asked_line is
  'Which line asked the role question: ''shared'' for the PropLane line, else the E.164 work number. NULL = written before this column existed.';
