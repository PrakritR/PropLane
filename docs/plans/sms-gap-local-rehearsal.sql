\set ON_ERROR_STOP on
begin;
do $$begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end$$;
create schema auth;
create table auth.users (id uuid primary key);
create table public.portal_scheduled_inbox_message_records (
  id text primary key,
  manager_user_id uuid not null references auth.users(id),
  status text not null,
  row_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
insert into public.portal_scheduled_inbox_message_records(id,manager_user_id,status)
values ('scheduled-1','00000000-0000-0000-0000-000000000001','scheduled');

\ir ../../supabase/migrations/20260913000000_payment_reminder_occurrences.sql
\ir ../../supabase/migrations/20260913010000_scheduled_inbox_channel_claims.sql

do $$
declare v_outcome text; v_token uuid; v_second uuid;
begin
  select outcome, token into v_outcome, v_token from public.claim_payment_reminder_channel(
    'occ-1','00000000-0000-0000-0000-000000000001','person@example.test',array['charge-1'],array['dedup-1'],'Subject','Body','email');
  if v_outcome <> 'claimed' or v_token is null then raise exception 'initial payment claim failed'; end if;
  select outcome into v_outcome from public.claim_payment_reminder_channel(
    'occ-2','00000000-0000-0000-0000-000000000001','person@example.test',array['charge-1'],array['dedup-1'],'Subject','Body','email');
  if v_outcome <> 'overlap' then raise exception 'payment overlap was not excluded'; end if;
  if not public.resolve_payment_reminder_channel('occ-1','email',v_token,'failed',null,'local test') then
    raise exception 'payment failure resolution failed';
  end if;
  select outcome, token into v_outcome, v_second from public.claim_payment_reminder_channel(
    'occ-1','00000000-0000-0000-0000-000000000001','person@example.test',array['charge-1'],array['dedup-1'],'Subject','Body','email');
  if v_outcome <> 'claimed' or v_second is null or v_second = v_token then raise exception 'failed payment retry was not claimed'; end if;
  update public.payment_reminder_channel_deliveries set claim_expires_at=now()-interval '1 minute'
    where occurrence_id='occ-1' and channel='email';
  select outcome into v_outcome from public.claim_payment_reminder_channel(
    'occ-1','00000000-0000-0000-0000-000000000001','person@example.test',array['charge-1'],array['dedup-1'],'Subject','Body','email');
  if v_outcome <> 'unknown' then raise exception 'expired payment claim was not unknown'; end if;
end $$;

do $$
declare v_outcome text; v_token uuid; v_blocked boolean;
begin
  select outcome into v_outcome from public.claim_scheduled_inbox_channel(
    'scheduled-1','00000000-0000-0000-0000-000000000002','inbox');
  if v_outcome <> 'missing' then raise exception 'scheduled owner mismatch not fenced'; end if;
  select outcome, token into v_outcome, v_token from public.claim_scheduled_inbox_channel(
    'scheduled-1','00000000-0000-0000-0000-000000000001','inbox');
  if v_outcome <> 'claimed' or v_token is null then raise exception 'scheduled claim failed'; end if;
  if (select status from public.portal_scheduled_inbox_message_records where id='scheduled-1') <> 'sending' then
    raise exception 'scheduled row did not enter sending';
  end if;
  v_blocked := false;
  begin
    update public.portal_scheduled_inbox_message_records set row_data='{"edited":true}'::jsonb where id='scheduled-1';
  exception when raise_exception then v_blocked := true; end;
  if not v_blocked then raise exception 'sending edit was allowed'; end if;
  v_blocked := false;
  begin
    delete from public.portal_scheduled_inbox_message_records where id='scheduled-1';
  exception when raise_exception then v_blocked := true; end;
  if not v_blocked then raise exception 'sending delete was allowed'; end if;
  if public.finalize_scheduled_inbox_delivery('scheduled-1','00000000-0000-0000-0000-000000000001') then
    raise exception 'finalized before three channels';
  end if;
  if not public.resolve_scheduled_inbox_channel('scheduled-1','inbox',v_token,'submitted',null) then
    raise exception 'inbox resolution failed';
  end if;
  select outcome, token into v_outcome, v_token from public.claim_scheduled_inbox_channel(
    'scheduled-1','00000000-0000-0000-0000-000000000001','email');
  if v_outcome <> 'claimed' or not public.resolve_scheduled_inbox_channel('scheduled-1','email',v_token,'skipped',null) then
    raise exception 'email resolution failed';
  end if;
  if public.finalize_scheduled_inbox_delivery('scheduled-1','00000000-0000-0000-0000-000000000001') then
    raise exception 'finalized with only two channels';
  end if;
  select outcome, token into v_outcome, v_token from public.claim_scheduled_inbox_channel(
    'scheduled-1','00000000-0000-0000-0000-000000000001','sms');
  if v_outcome <> 'claimed' or not public.resolve_scheduled_inbox_channel('scheduled-1','sms',v_token,'submitted',null) then
    raise exception 'sms resolution failed';
  end if;
  if public.finalize_scheduled_inbox_delivery('scheduled-1','00000000-0000-0000-0000-000000000001') is not true then
    raise exception 'three-channel finalization failed';
  end if;
  if (select status from public.portal_scheduled_inbox_message_records where id='scheduled-1') <> 'sent' then
    raise exception 'scheduled row was not sent';
  end if;
end $$;

select 'sms-gap-local-rehearsal-passed' as result;
rollback;
