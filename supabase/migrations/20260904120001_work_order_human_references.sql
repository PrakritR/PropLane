-- Stable, human-typeable work-order handles. The existing text id remains the
-- primary key; this sequence is unique only within the owning manager's scope.

create table if not exists public.work_order_reference_counters (
  manager_user_id uuid primary key,
  next_sequence bigint not null check (next_sequence between 1000 and 99999999)
);

alter table public.work_order_reference_counters enable row level security;
revoke all on table public.work_order_reference_counters from anon, authenticated;

alter table public.portal_work_order_records
  add column if not exists reference_sequence bigint;

-- Backfill deterministically so every existing manager-owned order gets a
-- readable handle without changing its primary key.
with numbered as (
  select
    id,
    row_number() over (
      partition by manager_user_id
      order by created_at, id
    ) + 999 as sequence
  from public.portal_work_order_records
  where manager_user_id is not null
    and reference_sequence is null
)
update public.portal_work_order_records as work_order
set reference_sequence = numbered.sequence,
    row_data = jsonb_set(
      coalesce(work_order.row_data, '{}'::jsonb),
      '{reference}',
      to_jsonb('WO-' || numbered.sequence::text),
      true
    )
from numbered
where work_order.id = numbered.id;

insert into public.work_order_reference_counters (manager_user_id, next_sequence)
select manager_user_id, max(reference_sequence) + 1
from public.portal_work_order_records
where manager_user_id is not null
  and reference_sequence is not null
group by manager_user_id
on conflict (manager_user_id) do update
set next_sequence = greatest(
  public.work_order_reference_counters.next_sequence,
  excluded.next_sequence
);

create unique index if not exists portal_work_order_records_manager_reference_uidx
  on public.portal_work_order_records (manager_user_id, reference_sequence)
  where manager_user_id is not null and reference_sequence is not null;

create or replace function public.assign_work_order_human_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allocated bigint;
begin
  if new.manager_user_id is null then
    return new;
  end if;

  if new.reference_sequence is null then
    insert into public.work_order_reference_counters (manager_user_id, next_sequence)
    values (new.manager_user_id, 1001)
    on conflict (manager_user_id) do update
      set next_sequence = public.work_order_reference_counters.next_sequence + 1
    returning next_sequence - 1 into allocated;
    new.reference_sequence := allocated;
  end if;

  new.row_data := jsonb_set(
    coalesce(new.row_data, '{}'::jsonb),
    '{reference}',
    to_jsonb('WO-' || new.reference_sequence::text),
    true
  );
  return new;
end;
$$;

revoke all on function public.assign_work_order_human_reference() from public, anon, authenticated;

drop trigger if exists portal_work_order_assign_human_reference
  on public.portal_work_order_records;
create trigger portal_work_order_assign_human_reference
before insert or update of manager_user_id, reference_sequence, row_data
on public.portal_work_order_records
for each row execute function public.assign_work_order_human_reference();
