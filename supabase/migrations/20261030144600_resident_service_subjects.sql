-- Resident-created services belong to an Auth subject, never an email address.
alter table public.portal_work_order_records add column if not exists resident_user_id uuid references auth.users(id) on delete set null;
alter table public.portal_service_request_records add column if not exists resident_user_id uuid references auth.users(id) on delete set null;
alter table public.portal_work_order_records add column if not exists row_revision bigint not null default 0;
alter table public.portal_service_request_records add column if not exists row_revision bigint not null default 0;
alter table public.portal_work_order_records add column if not exists resident_subject_was_bound boolean not null default false;
alter table public.portal_service_request_records add column if not exists resident_subject_was_bound boolean not null default false;
create index if not exists portal_work_order_records_resident_subject_idx on public.portal_work_order_records (resident_user_id);
create index if not exists portal_service_request_records_resident_subject_idx on public.portal_service_request_records (resident_user_id);

create or replace function public.sync_resident_service_subject() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.row_revision := greatest(coalesce(new.row_revision, 0), 0) + 1;
    new.resident_subject_was_bound := new.resident_user_id is not null;
  else
    new.row_revision := old.row_revision + 1;
    new.resident_subject_was_bound := old.resident_subject_was_bound;
    if old.resident_user_id is null and new.resident_user_id is not null then
      raise exception 'Existing service subject cannot be assigned' using errcode = '23514';
    end if;
    if old.resident_user_id is not null then
      if new.resident_user_id is not null and new.resident_user_id <> old.resident_user_id then
        raise exception 'Service subject cannot be changed' using errcode = '23514';
      end if;
      -- FK SET NULL runs as a nested trigger after the Auth row is removed.
      if new.resident_user_id is null and not (pg_catalog.pg_trigger_depth() > 1 and
          not exists (select 1 from auth.users where id = old.resident_user_id)) then
        new.resident_user_id := old.resident_user_id;
      end if;
    end if;
  end if;
  new.row_data := case when new.resident_user_id is null
    then new.row_data - 'residentUserId'
    else pg_catalog.jsonb_set(new.row_data, '{residentUserId}', pg_catalog.to_jsonb(new.resident_user_id::text), true)
  end;
  return new;
end $$;
revoke all on function public.sync_resident_service_subject() from public, anon, authenticated;
drop trigger if exists resident_service_subject on public.portal_work_order_records;
create trigger resident_service_subject before insert or update on public.portal_work_order_records for each row execute function public.sync_resident_service_subject();
drop trigger if exists resident_service_subject on public.portal_service_request_records;
create trigger resident_service_subject before insert or update on public.portal_service_request_records for each row execute function public.sync_resident_service_subject();
