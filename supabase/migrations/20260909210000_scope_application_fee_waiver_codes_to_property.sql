-- Application-fee waiver codes are per PROPERTY, not per portfolio.
--
-- The settings modal has always presented one code per property, and
-- `upsertPropertyApplicationFeeWaiverCode` already stored them that way by
-- tagging `label = 'listing:<propertyId>'`. Redemption never read that tag: its
-- only conditions were manager + code + active + unexpired + under max-uses, so
-- a code set on one listing waived the fee on EVERY listing that manager owned.
-- The UI said "this property's application"; the database disagreed.
--
-- `property_id` null keeps the old portfolio-wide meaning. That is deliberate:
-- a code created through `setPrimaryApplicationFeeWaiverCode` carries no listing
-- label, so there is no property to pin it to, and silently pinning it to an
-- arbitrary one would revoke a waiver a manager is relying on. Labelled codes
-- ARE pinned by the backfill below.
--
-- Idempotent (`if not exists` / `create or replace`), per the repo rule that
-- migrations are replayed by `db push --include-all`.

alter table public.manager_application_fee_waiver_codes
  add column if not exists property_id text;

comment on column public.manager_application_fee_waiver_codes.property_id is
  'Listing this code waives the fee on. NULL = every property this manager owns (legacy portfolio-wide codes).';

-- Backfill: a `listing:<propertyId>` label is the property this code was always
-- meant for. Only fills rows not already pinned, so a replay cannot clobber a
-- later hand-set value.
update public.manager_application_fee_waiver_codes
   set property_id = nullif(substring(label from char_length('listing:') + 1), '')
 where property_id is null
   and label like 'listing:%';

-- Lookup path is (manager, property) — index it that way.
create index if not exists manager_application_fee_waiver_codes_property_idx
  on public.manager_application_fee_waiver_codes (manager_user_id, property_id);

-- Atomic validate-and-redeem. Byte-for-byte the original except for the one
-- added property condition: same invoker rights (NOT security definer), same
-- single-statement increment so two applicants cannot both win the last use of
-- a limited-use code, same redemption insert.
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
    and (expires_at is null or expires_at > now())
    and (max_uses is null or used_count < max_uses)
    -- A NULL property_id is a legacy portfolio-wide code and still applies
    -- everywhere; a pinned code waives ONLY its own listing.
    and (property_id is null or property_id = p_property_id)
  returning manager_application_fee_waiver_codes.id into v_id;

  if v_id is null then
    return;
  end if;

  insert into public.application_fee_waiver_redemptions
    (code_id, manager_user_id, property_id, resident_email, application_id)
  values (p_code_id, p_manager_user_id, p_property_id, p_resident_email, p_application_id);

  id := v_id;
  return next;
end;
$$ language plpgsql;

-- Re-assert the original posture: service-role only, never anon/authenticated.
revoke all on function public.redeem_application_fee_waiver_code(uuid, uuid, text, text, text) from public, anon, authenticated;
