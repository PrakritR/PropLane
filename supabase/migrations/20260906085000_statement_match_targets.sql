-- Match either a receipt or an expense, validating every writer under a target
-- row lock. Existing legacy duplicates remain visible for manual reconciliation.
alter table public.manager_bank_statement_lines add column if not exists matched_expense_entry_id uuid references public.manager_expense_entries(id) on delete set null;
alter table public.manager_bank_statement_lines add constraint bank_line_one_target check (matched_ledger_entry_id is null or matched_expense_entry_id is null);
create or replace function public.validate_bank_statement_match() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_id uuid; target_owner uuid; target_amount bigint; target_kind text;
begin
  if new.matched_ledger_entry_id is null and new.matched_expense_entry_id is null then return new; end if;
  select manager_user_id into owner_id from public.manager_bank_statements where id=new.statement_id;
  if new.matched_ledger_entry_id is not null then
    select manager_user_id,amount_cents,entry_type into target_owner,target_amount,target_kind from public.ledger_entries where id=new.matched_ledger_entry_id for update;
    if not found or target_owner is distinct from owner_id or target_kind <> 'payment' or target_amount <> new.amount_cents then raise exception 'Receipt must belong to this manager and match the signed bank amount'; end if;
    if exists(select 1 from public.manager_bank_statement_lines where matched_ledger_entry_id=new.matched_ledger_entry_id and id<>new.id) then raise exception 'Receipt is already matched'; end if;
  else
    select manager_user_id,amount_cents into target_owner,target_amount from public.manager_expense_entries where id=new.matched_expense_entry_id for update;
    if not found or target_owner is distinct from owner_id or -target_amount <> new.amount_cents then raise exception 'Expense must belong to this manager and match the signed bank amount'; end if;
    if exists(select 1 from public.manager_bank_statement_lines where matched_expense_entry_id=new.matched_expense_entry_id and id<>new.id) then raise exception 'Expense is already matched'; end if;
  end if;
  return new;
end $$;
revoke all on function public.validate_bank_statement_match() from public,anon,authenticated;
create trigger bank_statement_match_target before insert or update on public.manager_bank_statement_lines for each row execute function public.validate_bank_statement_match();
