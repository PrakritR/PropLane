-- Waive codes cover the LEASE fee as well as the application fee, and can be limited to several
-- properties (leasing pipeline plan, decision D4: workspace-wide, optionally limited to properties).
--
-- Additive only. Every existing code keeps working exactly as before:
--   * `applies_to` defaults to 'application', so a code written before this migration still waives the
--     application fee and nothing else.
--   * `property_ids` is null for every existing row, so the legacy single `property_id` (or null =
--     portfolio-wide) still decides where a code applies.
--
-- Where a code applies: `property_ids` when it is a non-empty list, else the legacy `property_id` when
-- set, else every property the manager owns. One function (`waiver_code_covers_property`) is the only
-- place that rule is written, so the application redeem and the lease redeem cannot drift apart.
--
-- Idempotent (`if not exists` / `create or replace` / drop-then-add constraint), per the repo rule that
-- migrations are replayed by `db push --include-all`.

alter table public.manager_application_fee_waiver_codes
  add column if not exists applies_to text not null default 'application';

alter table public.manager_application_fee_waiver_codes
  add column if not exists property_ids text[];

alter table public.manager_application_fee_waiver_codes
  drop constraint if exists manager_application_fee_waiver_codes_applies_to_check;
alter table public.manager_application_fee_waiver_codes
  add constraint manager_application_fee_waiver_codes_applies_to_check
  check (applies_to in ('application', 'lease', 'both'));

comment on column public.manager_application_fee_waiver_codes.applies_to is
  'Which fee this code waives: application, lease, or both. Defaults to application so every pre-existing code is unchanged.';
comment on column public.manager_application_fee_waiver_codes.property_ids is
  'Properties this code is limited to. NULL or empty = fall back to property_id (legacy single property), else every property the manager owns.';

-- One rule for "does this code apply on this property".
create or replace function public.waiver_code_covers_property(
  p_property_id text,
  p_property_ids text[],
  p_target_property_id text
) returns boolean as $$
  select case
    when p_property_ids is not null and coalesce(array_length(p_property_ids, 1), 0) > 0
      then p_target_property_id = any (p_property_ids)
    when p_property_id is not null
      then p_property_id = p_target_property_id
    else true
  end;
$$ language sql immutable;

-- The redemption audit now also records a LEASE redemption: what it was spent on, and which lease. A
-- lease can be waived by a code once (the partial unique index), so two simultaneous redemptions for the
-- same lease cannot both spend a use.
alter table public.application_fee_waiver_redemptions
  add column if not exists kind text not null default 'application';
alter table public.application_fee_waiver_redemptions
  add column if not exists lease_id text;

alter table public.application_fee_waiver_redemptions
  drop constraint if exists application_fee_waiver_redemptions_kind_check;
alter table public.application_fee_waiver_redemptions
  add constraint application_fee_waiver_redemptions_kind_check
  check (kind in ('application', 'lease'));

create unique index if not exists application_fee_waiver_redemptions_lease_once_idx
  on public.application_fee_waiver_redemptions (lease_id)
  where lease_id is not null;

-- Atomic validate-and-redeem for the APPLICATION fee. Same signature, invoker rights and single-statement
-- increment as before; the only additions are the `applies_to` condition and the multi-property limit.
create or replace function public.redeem_application_fee_waiver_code(
  p_code_id uuid,
  p_manager_user_id uuid,
  p_property_id text,
  p_resident_email text,
  p_application_id text
) returns table (id uuid) as $$
declare
  v_id uuid;
begin
  update public.manager_application_fee_waiver_codes
  set used_count = used_count + 1
  where manager_application_fee_waiver_codes.id = p_code_id
    and manager_user_id = p_manager_user_id
    and status = 'active'
    and applies_to in ('application', 'both')
    and (expires_at is null or expires_at > now())
    and (max_uses is null or used_count < max_uses)
    and public.waiver_code_covers_property(property_id, property_ids, p_property_id)
  returning manager_application_fee_waiver_codes.id into v_id;

  if v_id is null then
    return;
  end if;

  insert into public.application_fee_waiver_redemptions
    (code_id, manager_user_id, property_id, resident_email, application_id, kind)
  values (p_code_id, p_manager_user_id, p_property_id, p_resident_email, p_application_id, 'application');

  id := v_id;
  return next;
end;
$$ language plpgsql;

revoke all on function public.redeem_application_fee_waiver_code(uuid, uuid, text, text, text) from public, anon, authenticated;

-- Atomic validate-and-redeem for the LEASE fee. Returns the code id and the redemption id (the redemption
-- id is what `release_lease_fee_waiver_redemption` needs if the waiver itself then fails to apply).
-- Returns no rows when the code is inactive, expired, exhausted, not a lease code, not valid on this
-- property, another manager's, or when this lease already has a code redemption. The advisory lock makes
-- the per-lease check and the increment one critical section, so a double click spends one use.
create or replace function public.redeem_lease_fee_waiver_code(
  p_code_id uuid,
  p_manager_user_id uuid,
  p_property_id text,
  p_resident_email text,
  p_lease_id text
) returns table (id uuid, redemption_id uuid) as $$
declare
  v_id uuid;
  v_redemption uuid;
begin
  perform pg_advisory_xact_lock(hashtext('lease_fee_waiver:' || p_lease_id));

  if exists (
    select 1 from public.application_fee_waiver_redemptions r where r.lease_id = p_lease_id
  ) then
    return;
  end if;

  update public.manager_application_fee_waiver_codes
  set used_count = used_count + 1
  where manager_application_fee_waiver_codes.id = p_code_id
    and manager_user_id = p_manager_user_id
    and status = 'active'
    and applies_to in ('lease', 'both')
    and (expires_at is null or expires_at > now())
    and (max_uses is null or used_count < max_uses)
    and public.waiver_code_covers_property(property_id, property_ids, p_property_id)
  returning manager_application_fee_waiver_codes.id into v_id;

  if v_id is null then
    return;
  end if;

  insert into public.application_fee_waiver_redemptions
    (code_id, manager_user_id, property_id, resident_email, application_id, kind, lease_id)
  values (p_code_id, p_manager_user_id, p_property_id, p_resident_email, null, 'lease', p_lease_id)
  returning application_fee_waiver_redemptions.id into v_redemption;

  id := v_id;
  redemption_id := v_redemption;
  return next;
end;
$$ language plpgsql;

revoke all on function public.redeem_lease_fee_waiver_code(uuid, uuid, text, text, text) from public, anon, authenticated;

-- Give a lease redemption back when the waiver it paid for could not be applied (the fee was paid in the
-- meantime, a write failed). Removes the audit row and returns the use, so a failure never costs a use.
create or replace function public.release_lease_fee_waiver_redemption(
  p_redemption_id uuid
) returns boolean as $$
declare
  v_code uuid;
begin
  delete from public.application_fee_waiver_redemptions
  where application_fee_waiver_redemptions.id = p_redemption_id
    and kind = 'lease'
  returning code_id into v_code;

  if v_code is null then
    return false;
  end if;

  update public.manager_application_fee_waiver_codes
  set used_count = greatest(used_count - 1, 0)
  where manager_application_fee_waiver_codes.id = v_code;
  return true;
end;
$$ language plpgsql;

revoke all on function public.release_lease_fee_waiver_redemption(uuid) from public, anon, authenticated;
