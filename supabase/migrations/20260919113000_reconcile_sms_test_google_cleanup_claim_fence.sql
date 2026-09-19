-- The immutable authenticated-SMS migration excluded captured test cleanup
-- rows, but replaced the existing create-intent fence. Restore both guards:
-- a cleanup worker may never delete while a deterministic Google create could
-- still commit, and it may never claim a non-delivering SMS-test receipt.

create or replace function public.claim_prospect_tour_google_calendar_cleanup(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns table(planned_event_id text, manager_user_id uuid, google_calendar_event_id text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.prospect_tour_google_calendar_cleanup;
begin
  select c.* into v_row
    from public.prospect_tour_google_calendar_cleanup c
    where c.sms_test_session_id is null
      and (c.status='pending' or (c.status='running' and c.lease_expires_at<=now()))
      and not exists (
        select 1
          from public.prospect_tour_google_calendar_create_intents i
          where i.planned_event_id=c.planned_event_id
            and i.state in ('creating','cleanup_required','reconcile_current','reconciling')
      )
    order by c.updated_at asc
    for update skip locked
    limit 1;
  if not found then return; end if;

  update public.prospect_tour_google_calendar_cleanup c
    set status='running',
        attempts=c.attempts+1,
        lease_owner=p_worker_id,
        lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),
        updated_at=now()
    where c.planned_event_id=v_row.planned_event_id;

  return query select v_row.planned_event_id,v_row.manager_user_id,v_row.google_calendar_event_id;
end;
$$;

revoke execute on function public.claim_prospect_tour_google_calendar_cleanup(text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_prospect_tour_google_calendar_cleanup(text,integer)
  to service_role;
