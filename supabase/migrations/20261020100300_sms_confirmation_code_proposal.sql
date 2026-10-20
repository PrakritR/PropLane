-- The confirmation code's attempt budget belongs to ONE PROPOSAL, not to its subject for ever.
--
-- A dispatch run raises proposals in succession (a second texted invoice, a new held quote after a retry). With the
-- budget keyed on the run alone, three wrong codes on the first proposal left `attempts` at the cap for good, so
-- every later proposal on that run was refused - and auto-declined - on the manager's first reply, correct code or
-- not. `proposal_id` records which proposal the stored code belongs to: a new proposal resets the count, a re-ask of
-- the open one does not.
--
-- Also: R / B on an exhausted chain re-text vendors, so they carry a code too (`dispatch_retry`).
--
-- Idempotent; additive.

alter table public.sms_confirmation_codes
  add column if not exists proposal_id text;

alter table public.sms_confirmation_codes drop constraint if exists sms_confirmation_codes_subject_kind_check;
alter table public.sms_confirmation_codes
  add constraint sms_confirmation_codes_subject_kind_check
  check (subject_kind in ('pending_action', 'dispatch_approval', 'dispatch_quote', 'dispatch_invoice', 'dispatch_retry'));

-- The daily plan reconcile needs to make PROGRESS: ordered by user_id it re-checked the same first page every day
-- and never reached the tail, which is exactly where an unreconciled cancellation hides. The sweep now takes the
-- least recently checked rows and stamps them, so every paid plan comes round.
alter table public.manager_purchases
  add column if not exists plan_reconciled_at timestamptz;

create index if not exists manager_purchases_plan_reconciled_idx
  on public.manager_purchases (plan_reconciled_at nulls first);
