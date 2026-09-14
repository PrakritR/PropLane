-- Add recovery wiring for a table introduced after the original trigger installer.
-- Existing same-named triggers must already be the exact recovery triggers.
begin;

do $tour_followup_recovery_guards$
declare
  controls_table oid;
  write_guard_function oid;
  capture_delete_function oid;
  existing_trigger record;
begin
  select c.oid into controls_table
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'manager_tour_followup_controls'
    and c.relkind in ('r', 'p');

  select p.oid into write_guard_function
  from pg_proc p
  where p.oid = to_regprocedure('public.account_recovery_write_guard()')
    and p.prorettype = 'pg_catalog.trigger'::regtype;

  select p.oid into capture_delete_function
  from pg_proc p
  where p.oid = to_regprocedure('public.account_recovery_capture_delete()')
    and p.prorettype = 'pg_catalog.trigger'::regtype;

  if controls_table is null
    or write_guard_function is null
    or capture_delete_function is null then
    raise exception 'tour follow-up recovery guard prerequisites are missing';
  end if;

  select * into existing_trigger
  from pg_trigger
  where tgrelid = controls_table
    and tgname = 'account_recovery_write_guard';

  if found then
    if existing_trigger.tgisinternal
      or existing_trigger.tgfoid <> write_guard_function
      or existing_trigger.tgtype <> 31
      or existing_trigger.tgattr::text <> ''
      or existing_trigger.tgenabled <> 'O'
      or existing_trigger.tgnargs <> 0
      or existing_trigger.tgqual is not null
      or existing_trigger.tgconstraint <> 0 then
      raise exception 'manager_tour_followup_controls account_recovery_write_guard conflicts with the required recovery trigger';
    end if;
  else
    execute 'create trigger account_recovery_write_guard before insert or update or delete on public.manager_tour_followup_controls for each row execute function public.account_recovery_write_guard()';
  end if;

  select * into existing_trigger
  from pg_trigger
  where tgrelid = controls_table
    and tgname = 'account_recovery_capture_delete';

  if found then
    if existing_trigger.tgisinternal
      or existing_trigger.tgfoid <> capture_delete_function
      or existing_trigger.tgtype <> 9
      or existing_trigger.tgattr::text <> ''
      or existing_trigger.tgenabled <> 'O'
      or existing_trigger.tgnargs <> 0
      or existing_trigger.tgqual is not null
      or existing_trigger.tgconstraint <> 0 then
      raise exception 'manager_tour_followup_controls account_recovery_capture_delete conflicts with the required recovery trigger';
    end if;
  else
    execute 'create trigger account_recovery_capture_delete after delete on public.manager_tour_followup_controls for each row execute function public.account_recovery_capture_delete()';
  end if;
end
$tour_followup_recovery_guards$;

commit;
