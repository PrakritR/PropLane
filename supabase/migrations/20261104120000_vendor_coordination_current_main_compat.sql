-- Preserve the installed coordination version and its directory/service lock order.
-- Bind residents to authenticated subjects and align accepted bids with current main.
do $vendor_compat$
declare
  definition text;
  before_fragment text;
  after_fragment text;
  expected integer;
  before_count integer;
  after_count integer;
  patch record;
begin
  if to_regprocedure('public.vendor_coordination_action(jsonb)') is null then
    raise exception 'vendor coordination prerequisite missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='portal_work_order_records' and column_name='resident_user_id') or
     not exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_order_bids' and column_name='bid_submitted_at') then
    raise exception 'current-main vendor schema prerequisites missing';
  end if;
  definition := pg_get_functiondef('public.vendor_coordination_action(jsonb)'::regprocedure);
  for patch in select * from (values
    ($before$if nullif(lower(trim(p_action->>'resident_email')),'') is distinct from lower(v_work.resident_email) then$before$, $after$if v_work.resident_user_id is null or v_actor is distinct from v_work.resident_user_id then$after$, 1),
    ($before$nullif(trim(v_work.resident_email),'') is not null$before$, $after$v_work.resident_user_id is not null$after$, 3),
    ($before$action_event_deliveries(event_id,audience,recipient_key,recipient_email,$before$, $after$action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,$after$, 3),
    ($before$values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),$before$, $after$values(v_event_id,'resident',v_work.resident_user_id::text,v_work.resident_user_id,$after$, 3),
    ($before$proposed_time = v_start, note = v_proposal.scope, status = 'accepted', updated_at = now()$before$, $after$proposed_time = v_start, note = v_proposal.scope, status = 'accepted', bid_submitted_at = now(), updated_at = now()$after$, 1),
    ($before$amount_cents,materials_cents,proposed_time,note,status,quote_mode)$before$, $after$amount_cents,materials_cents,proposed_time,note,status,quote_mode,bid_submitted_at)$after$, 1),
    ($before$v_proposal.labor_cents,v_proposal.materials_cents,v_start,v_proposal.scope,'accepted','upfront')$before$, $after$v_proposal.labor_cents,v_proposal.materials_cents,v_start,v_proposal.scope,'accepted','upfront',now())$after$, 1),
    ($before$'biddingOpen',false,'bucket','scheduled','visitDurationMinutes',v_proposal.duration_minutes)$before$, $after$'biddingOpen',false,'bucket','scheduled','status','Scheduled','visitDurationMinutes',v_proposal.duration_minutes)$after$, 1)
  ) fragments(before_fragment,after_fragment,expected) loop
    before_fragment := patch.before_fragment;
    after_fragment := patch.after_fragment;
    expected := patch.expected;
    before_count := (length(definition)-length(replace(definition,before_fragment,'')))/length(before_fragment);
    after_count := (length(definition)-length(replace(definition,after_fragment,'')))/length(after_fragment);
    if before_count = expected then
      definition := replace(definition,before_fragment,after_fragment);
    elsif before_count <> 0 or after_count < expected then
      raise exception 'unrecognized vendor coordination definition; reviewed compatibility patch refused';
    end if;
  end loop;
  execute definition;
end
$vendor_compat$;
revoke all on function public.vendor_coordination_action(jsonb) from public,anon,authenticated;
grant execute on function public.vendor_coordination_action(jsonb) to service_role;
