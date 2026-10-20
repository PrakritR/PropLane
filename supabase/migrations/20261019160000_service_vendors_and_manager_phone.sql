-- PropLane Service: the service manager's phone, and a one-time code purpose for verifying it
-- (captain, Oct 19 2026). Additive and idempotent.
--
--   * platform_service_settings.manager_phone_e164 / manager_phone_verified_at: the phone that acts as the
--     service manager. A text FROM this verified number to the PropLane line is the manager of every
--     is_service workspace (full manager agent), and it is where the service's manager alerts are texted.
--     The setting is authoritative: profiles.phone is NOT consulted (several test profiles can hold the
--     same number). The table is service_role only (RLS on, no policies), already classified in
--     account-purge-manifest.ts.
--   * phone_otp_challenges.purpose gains 'service_manager': the six-digit code that proves the admin holds
--     the phone before it is saved as verified.
--
-- The vendor roster needs no table: a roster vendor is a `manager_vendor_records` row owned by the service
-- owner with row_data.serviceRoster = true (name, phone, dispatchTrades, serviceArea, dispatchAvailable and
-- the consent machinery already live there). docs/agents/vendor-dispatch-agent.md § Service roster.

alter table public.platform_service_settings add column if not exists manager_phone_e164 text;
alter table public.platform_service_settings add column if not exists manager_phone_verified_at timestamptz;
alter table public.platform_service_settings drop constraint if exists platform_service_settings_manager_phone_check;
alter table public.platform_service_settings add constraint platform_service_settings_manager_phone_check
  check (manager_phone_e164 is null or manager_phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
-- A verified stamp without a phone is meaningless: clear both together.
alter table public.platform_service_settings drop constraint if exists platform_service_settings_manager_verified_check;
alter table public.platform_service_settings add constraint platform_service_settings_manager_verified_check
  check (manager_phone_verified_at is null or manager_phone_e164 is not null);

-- Restate the allowed purposes as the UNION of what the live constraint already allows (other branches add values,
-- e.g. 'sms_signup' in 20261019150000) and the ones known here, so this migration can never narrow the list.
do $$
declare
  existing text[] := '{}';
  def text;
  wanted text[] := array['link_unlock', 'public_bind', 'sign_in', 'change_number_old', 'change_number_new', 'sms_signup', 'service_manager'];
  merged text[];
  list text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    where c.conrelid = 'public.phone_otp_challenges'::regclass and c.conname = 'phone_otp_challenges_purpose_check';
  if def is not null then
    select coalesce(array_agg(m[1]), '{}') into existing from regexp_matches(def, '''([a-z_]+)''', 'g') as m;
  end if;
  select array_agg(distinct v order by v) into merged from unnest(existing || wanted) as v;
  select string_agg(quote_literal(v), ', ') into list from unnest(merged) as v;
  alter table public.phone_otp_challenges drop constraint if exists phone_otp_challenges_purpose_check;
  execute format('alter table public.phone_otp_challenges add constraint phone_otp_challenges_purpose_check check (purpose in (%s))', list);
end $$;

-- Roster lookups by service owner + the roster flag (the dispatch matcher and the admin list).
create index if not exists manager_vendor_records_service_roster_idx
  on public.manager_vendor_records (manager_user_id)
  where (row_data ->> 'serviceRoster') = 'true';
