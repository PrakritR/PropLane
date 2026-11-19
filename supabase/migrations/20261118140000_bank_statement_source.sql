-- Who created a bank statement. The Plaid feed may only derive balances onto a statement IT created
-- ('plaid_feed'); anything the manager made by hand or imported from a file stays 'manual' and its typed
-- opening / closing numbers are never rewritten. Default 'manual' so every pre-existing row — and every
-- future manual insert that does not name a source — fails closed to the manager's.
alter table public.manager_bank_statements
  add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.manager_bank_statements'::regclass
      and conname = 'manager_bank_statements_source_check'
  ) then
    alter table public.manager_bank_statements
      add constraint manager_bank_statements_source_check check (source in ('manual', 'plaid_feed'));
  end if;
end $$;
