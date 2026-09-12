-- Proposed, additive recovery protection for the two account-owned credit histories.
-- This is deliberately a rollout artifact, not a canonical migration.
do $comms_credit_recovery_prerequisites$
begin
  if to_regclass('public.manager_comms_credit_purchases') is null
    or to_regclass('public.manager_comms_credit_adjustments') is null
    or to_regprocedure('public.account_recovery_write_guard()') is null
    or to_regprocedure('public.account_recovery_capture_delete()') is null then
    raise exception 'comms credit recovery guard prerequisites are missing';
  end if;
end
$comms_credit_recovery_prerequisites$;

do $comms_credit_recovery_triggers$
declare
  target_table regclass;
begin
  foreach target_table in array array[
    'public.manager_comms_credit_purchases'::regclass,
    'public.manager_comms_credit_adjustments'::regclass
  ] loop
    if not exists(select 1 from pg_trigger where tgrelid=target_table and tgname='account_recovery_write_guard' and not tgisinternal) then
      execute format('create trigger account_recovery_write_guard before insert or update or delete on %s for each row execute function public.account_recovery_write_guard()', target_table);
    end if;
    if not exists(select 1 from pg_trigger where tgrelid=target_table and tgname='account_recovery_capture_delete' and not tgisinternal) then
      execute format('create trigger account_recovery_capture_delete after delete on %s for each row execute function public.account_recovery_capture_delete()', target_table);
    end if;
  end loop;
end
$comms_credit_recovery_triggers$;
