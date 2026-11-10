-- Attach recovery guards to account-owned identity and deposit tables. Refuse missing prerequisites or conflicting triggers.
do $owned_recovery_guards$
declare
  target_name text;
  target_table oid;
  write_guard_function oid;
  capture_delete_function oid;
  existing_trigger record;
begin
  foreach target_name in array array[
    'resident_identity_subjects', 'resident_identity_inquiries',
    'resident_identity_webhook_events', 'resident_identity_manual_reviews',
    'resident_evidence_policies', 'security_deposit_return_attempts'
  ] loop
  select c.oid into target_table
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = target_name
    and c.relkind in ('r', 'p');

  select p.oid into write_guard_function
  from pg_proc p
  where p.oid = to_regprocedure('public.account_recovery_write_guard()')
    and p.prorettype = 'pg_catalog.trigger'::regtype;

  select p.oid into capture_delete_function
  from pg_proc p
  where p.oid = to_regprocedure('public.account_recovery_capture_delete()')
    and p.prorettype = 'pg_catalog.trigger'::regtype;

  if target_table is null
    or write_guard_function is null
    or capture_delete_function is null then
    raise exception 'recovery guard prerequisites missing for %', target_name;
  end if;

  select * into existing_trigger
  from pg_trigger
  where tgrelid = target_table
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
      raise exception '% account_recovery_write_guard conflicts with the required recovery trigger', target_name;
    end if;
  else
    execute format('create trigger account_recovery_write_guard before insert or update or delete on public.%I for each row execute function public.account_recovery_write_guard()', target_name);
  end if;

  select * into existing_trigger
  from pg_trigger
  where tgrelid = target_table
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
      raise exception '% account_recovery_capture_delete conflicts with the required recovery trigger', target_name;
    end if;
  else
    execute format('create trigger account_recovery_capture_delete after delete on public.%I for each row execute function public.account_recovery_capture_delete()', target_name);
  end if;
  end loop;
end
$owned_recovery_guards$;
