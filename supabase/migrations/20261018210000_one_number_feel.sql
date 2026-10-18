-- One-number SMS: delivery feel (W9). Additive and idempotent.
--   1. sms_runtime_config.feel_settings   per-switch overrides (bubbles, fast path, debounce)
--   2. sms_projection_turns latency/intent columns   the learning-loop log of every answered text
--   3. sms_reply_debounce + three RPCs    the 1.5 s "wait for the last text" burst merge
-- Service-role only like every other SMS table: RLS on, no anon/authenticated grants.

-- 1. Settings -----------------------------------------------------------------
alter table public.sms_runtime_config
  add column if not exists feel_settings jsonb;

-- 2. Per-turn intent + latency log ---------------------------------------------
-- Written on the INBOUND projection turn of the text that was answered.
alter table public.sms_projection_turns
  add column if not exists intent text,
  add column if not exists reply_lane text,
  add column if not exists model_used text,
  add column if not exists fast_path boolean,
  add column if not exists bubble_count smallint,
  add column if not exists first_bubble_ms integer,
  add column if not exists total_latency_ms integer,
  add column if not exists reply_status text,
  add column if not exists replied_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_projection_turns_reply_status_check') then
    alter table public.sms_projection_turns
      add constraint sms_projection_turns_reply_status_check
      check (reply_status is null or reply_status in ('sent', 'draft', 'none'));
  end if;
end $$;

-- 3. Reply debounce -------------------------------------------------------------
-- One row per (owner, role, phone) scope. `entries` holds the texts that arrived
-- inside the quiet window, each stamped with the revision it created. The newest
-- revision answers them all as one message; older invocations yield.
create table if not exists public.sms_reply_debounce (
  scope_key text primary key,
  revision bigint not null default 0,
  entries jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sms_reply_debounce enable row level security;
revoke all on public.sms_reply_debounce from anon, authenticated;
grant all on public.sms_reply_debounce to service_role;

-- Add a text to the scope. Returns this text's revision (the existing one when the
-- same message sid registers again, so a webhook retry never bumps the count).
create or replace function public.sms_debounce_register(
  p_scope text, p_sid text, p_body text, p_now timestamptz default now()
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rev bigint;
begin
  if p_scope is null or p_scope = '' or p_sid is null or p_sid = '' then
    raise exception 'invalid debounce scope' using errcode = '22023';
  end if;
  insert into public.sms_reply_debounce as d (scope_key, revision, entries, updated_at)
  values (
    p_scope, 1,
    jsonb_build_array(jsonb_build_object('sid', p_sid, 'body', p_body, 'rev', 1, 'at', p_now)),
    p_now
  )
  on conflict (scope_key) do update set
    revision = case
      when exists (select 1 from jsonb_array_elements(d.entries) e where e->>'sid' = p_sid) then d.revision
      else d.revision + 1 end,
    entries = case
      when exists (select 1 from jsonb_array_elements(d.entries) e where e->>'sid' = p_sid) then d.entries
      else coalesce(
        (select jsonb_agg(e order by (e->>'rev')::bigint)
           from jsonb_array_elements(d.entries) e
          where (e->>'at')::timestamptz > p_now - interval '90 seconds'),
        '[]'::jsonb
      ) || jsonb_build_array(jsonb_build_object('sid', p_sid, 'body', p_body, 'rev', d.revision + 1, 'at', p_now))
    end,
    updated_at = p_now
  returning d.revision into v_rev;
  return (
    select coalesce((e->>'rev')::bigint, v_rev)
      from public.sms_reply_debounce s, jsonb_array_elements(s.entries) e
     where s.scope_key = p_scope and e->>'sid' = p_sid
     limit 1
  );
end $$;

-- After the quiet window: the texts this revision answers, or null when a newer
-- text arrived (this invocation yields to it).
create or replace function public.sms_debounce_claim(p_scope text, p_rev bigint)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select case
    when d.revision = p_rev then coalesce(
      (select jsonb_agg(e order by (e->>'rev')::bigint)
         from jsonb_array_elements(d.entries) e
        where (e->>'rev')::bigint <= p_rev),
      '[]'::jsonb)
    else null
  end
  from public.sms_reply_debounce d
  where d.scope_key = p_scope;
$$;

-- The reply for revisions up to p_rev is durable: drop those texts. Newer ones stay.
create or replace function public.sms_debounce_settle(p_scope text, p_rev bigint)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.sms_reply_debounce d
     set entries = coalesce(
       (select jsonb_agg(e order by (e->>'rev')::bigint)
          from jsonb_array_elements(d.entries) e
         where (e->>'rev')::bigint > p_rev),
       '[]'::jsonb),
         updated_at = now()
   where d.scope_key = p_scope;
$$;

revoke all on function public.sms_debounce_register(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sms_debounce_claim(text, bigint) from public, anon, authenticated;
revoke all on function public.sms_debounce_settle(text, bigint) from public, anon, authenticated;
grant execute on function public.sms_debounce_register(text, text, text, timestamptz) to service_role;
grant execute on function public.sms_debounce_claim(text, bigint) to service_role;
grant execute on function public.sms_debounce_settle(text, bigint) to service_role;
