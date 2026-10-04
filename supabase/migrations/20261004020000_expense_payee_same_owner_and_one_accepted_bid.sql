-- Two invariants the application layer alone could not hold. Additive and idempotent.
--
-- 1. An expense may only name a payee its OWN manager owns.
--
--    `manager_expense_entries.payee_id` is a plain FK to `manager_payees(id)`. RLS constrains
--    which ROW a client reaches, never which column it may write, and the pre-existing
--    `manager_expense_entries_owner` policy is `for all` on `manager_user_id = auth.uid()`
--    alone — so a signed-in manager could PATCH another manager's `payee_id` straight through
--    PostgREST, around the `findOwnedPayee` check in /api/expenses. Nothing renders the foreign
--    row (both readers resolve a payee against the caller's own list), but the reference is a
--    dangling cross-tenant pointer in the books. A trigger closes it for every writer.
--
-- 2. One approved bid per service.
--
--    Every payout-anchor read resolves the accepted bid with `.maybeSingle()`, which ERRORS on
--    two rows and yields null — and the payout then falls back to an amount from the request
--    body, defeating the immutable-anchor rule. `acceptWorkOrderBid` now refuses a second
--    accept; the partial unique index is what makes that true under a race.

create or replace function public.manager_expense_payee_same_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payee_id is null then
    return new;
  end if;
  if not exists (
    select 1
    from public.manager_payees p
    where p.id = new.payee_id
      and p.manager_user_id = new.manager_user_id
  ) then
    raise exception 'payee_id must name a payee owned by this expense''s manager'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists manager_expense_entries_payee_same_owner on public.manager_expense_entries;
create trigger manager_expense_entries_payee_same_owner
  before insert or update of payee_id, manager_user_id on public.manager_expense_entries
  for each row execute function public.manager_expense_payee_same_owner();

-- A service that already carries two accepted rows cannot take the index. Keep the bid of the
-- vendor the service is actually assigned to (falling back to the most recently touched one)
-- and decline the rest: the duplicate was never readable as an anchor anyway, because the
-- `.maybeSingle()` reads it feeds errored on it.
update public.work_order_bids b
set status = 'declined', updated_at = now()
where b.status = 'accepted'
  and exists (
    select 1 from public.work_order_bids other
    where other.work_order_id = b.work_order_id and other.status = 'accepted' and other.id <> b.id
  )
  and b.id <> (
    select pick.id
    from public.work_order_bids pick
    left join public.portal_work_order_records wo on wo.id = pick.work_order_id
    where pick.work_order_id = b.work_order_id and pick.status = 'accepted'
    order by
      (wo.vendor_user_id is not null and pick.vendor_user_id = wo.vendor_user_id) desc,
      pick.updated_at desc,
      pick.id
    limit 1
  );

create unique index if not exists work_order_bids_one_accepted_idx
  on public.work_order_bids (work_order_id)
  where status = 'accepted';
