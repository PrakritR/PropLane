-- Let a resident with no PropLane login pay their own rent from a phone-bound `/l/<token>` link.
--
-- Imported residents (placeholder `@import.proplane.local` addresses) have no Auth user, so their charges carry
-- `resident_user_id` null. `reserve_resident_checkout_attempt` refused every call without a resident user id, so
-- no checkout - the resident's link or a manager's assisted payment - could ever start for them.
--
-- Additive: replaces the function body only, from 20261005130000, with ONE change: `p_resident_user_id` may be
-- null. The per-charge check below is unchanged and is what keeps this narrow: a charge that names an account
-- still requires that exact account (`resident_user_id is distinct from p_resident_user_id` raises when the caller
-- passes null), and a charge without one still requires the exact resident address. An existing attempt is reused
-- only when its own resident id is the same (null = null). The app passes null only for a phone-verified rent
-- link whose charges have no account (`accountlessResident`), and freezes `resident_account = none` into the
-- attempt's metadata so an account-less attempt is never mistaken for one whose account was later deleted.

create or replace function public.reserve_resident_checkout_attempt(
  p_attempt_token uuid, p_resident_user_id uuid, p_resident_email text, p_manager_user_id uuid,
  p_charge_ids text[], p_charge_cents integer[], p_subtotal_cents integer,
  p_payer_total_cents integer, p_recipient_net_cents integer,
  p_payment_method text, p_provider_params jsonb
) returns public.resident_checkout_attempts language plpgsql security definer
  set search_path = public, pg_temp as $$
declare
  v_charge public.portal_household_charge_records%rowtype;
  v_id text;
  v_index integer := 0;
  v_owner uuid;
  v_slot public.resident_charge_payment_slots%rowtype;
  v_existing_id uuid;
  v_attempt public.resident_checkout_attempts%rowtype;
begin
  if p_attempt_token is null or p_manager_user_id is null or
     nullif(trim(p_resident_email), '') is null or
     cardinality(p_charge_ids) not between 1 and 10 or
     cardinality(p_charge_ids) <> cardinality(p_charge_cents) or
     p_charge_ids is distinct from (select array_agg(id order by id) from unnest(p_charge_ids) id) or
     (select count(distinct id) from unnest(p_charge_ids) id) <> cardinality(p_charge_ids) or
     (select sum(cents) from unnest(p_charge_cents) cents) is distinct from p_subtotal_cents or
     p_subtotal_cents < 100 or p_payer_total_cents < p_subtotal_cents or
     p_recipient_net_cents <= 0 or p_recipient_net_cents > p_subtotal_cents or
     p_payment_method not in ('ach','card') or
     jsonb_typeof(p_provider_params) is distinct from 'object' or
     p_provider_params->>'paymentMethod' is distinct from p_payment_method or
     p_provider_params->>'residentEmail' is distinct from lower(trim(p_resident_email)) or
     p_provider_params->'metadata'->>'resident_attempt_token' is distinct from p_attempt_token::text then
    raise exception 'Invalid resident checkout quote';
  end if;

  -- Lock every charge in sorted order. A conflicting [A,B] and [B,C] must
  -- finish as one whole-cart winner, never partial slots for the loser.
  for v_id in select id from unnest(p_charge_ids) id order by id loop
    select * into v_charge from public.portal_household_charge_records
      where id = v_id for update;
    v_index := v_index + 1;
    if not found or v_charge.status not in ('pending','failed','processing') or
       v_charge.row_data->>'id' is distinct from v_id or
       v_charge.row_data->>'status' not in ('pending','failed','processing') or
       v_charge.row_data->>'managerUserId' is distinct from v_charge.manager_user_id::text or
       coalesce(v_charge.row_data->>'propertyId','') is distinct from coalesce(v_charge.property_id, '') or
       lower(v_charge.row_data->>'residentEmail') is distinct from lower(v_charge.resident_email) or
       (case when v_charge.resident_user_id is not null
         then v_charge.resident_user_id is distinct from p_resident_user_id
         else lower(v_charge.resident_email) is distinct from lower(trim(p_resident_email)) end) or
       public.resident_claim_charge_cents(v_charge.row_data) is distinct from p_charge_cents[v_index] then
      raise exception 'Resident charge changed before checkout';
    end if;
    if nullif(trim(v_charge.property_id), '') is not null then
      select manager_user_id into v_owner from public.manager_property_records
        where id = v_charge.property_id for share;
      if not found or v_owner is null or v_owner is distinct from p_manager_user_id or
         v_charge.manager_user_id is distinct from v_owner then
        raise exception 'Resident charge owner needs payment review';
      end if;
    elsif v_charge.manager_user_id is distinct from p_manager_user_id then
      raise exception 'Propertyless charge manager changed before checkout';
    end if;
    if exists (select 1 from public.resident_autopay_runs r where r.charge_id = v_id
      and r.status in ('claimed','succeeded')) then
      raise exception 'Autopay already owns this charge';
    end if;
    select * into v_slot from public.resident_charge_payment_slots
      where charge_id = v_id for update;
    -- A pre-migration Checkout may have written its source reference without
    -- owning a new slot. Never mint a second source over that reference.
    if not found and nullif(trim(v_charge.row_data->>'stripeCheckoutSessionId'), '') is not null then
      raise exception 'Existing checkout source needs payment review';
    end if;
    if v_charge.status = 'processing' and
       (not found or v_slot.checkout_attempt_id is null or
        v_charge.row_data->>'stripeCheckoutSessionId' is null) then
      raise exception 'Processing charge has no matching checkout attempt';
    end if;
    if found then
      if v_slot.checkout_attempt_id is null then raise exception 'Another payment owns this charge'; end if;
      if v_existing_id is null then v_existing_id := v_slot.checkout_attempt_id;
      elsif v_existing_id is distinct from v_slot.checkout_attempt_id then
        raise exception 'Selected charges belong to different payment attempts';
      end if;
    elsif v_existing_id is not null then
      raise exception 'Selected charges overlap an existing payment';
    end if;
  end loop;

  if v_existing_id is not null then
    select * into v_attempt from public.resident_checkout_attempts where id = v_existing_id for update;
    if not found or v_attempt.status not in ('pending','processing') or
       v_attempt.resident_user_id is distinct from p_resident_user_id or
       v_attempt.manager_user_id is distinct from p_manager_user_id or
       v_attempt.resident_email is distinct from lower(trim(p_resident_email)) or
       v_attempt.charge_ids is distinct from p_charge_ids or
       v_attempt.charge_cents is distinct from p_charge_cents or
       v_attempt.subtotal_cents is distinct from p_subtotal_cents or
       v_attempt.payment_method is distinct from p_payment_method or
       (select count(*) from public.resident_charge_payment_slots
        where checkout_attempt_id = v_existing_id) <> cardinality(p_charge_ids) then
      raise exception 'A different payment attempt owns this cart';
    end if;
    return v_attempt;
  end if;

  insert into public.resident_checkout_attempts (
    attempt_token, resident_user_id, resident_email, manager_user_id, charge_ids, charge_cents,
    subtotal_cents, payer_total_cents, recipient_net_cents, payment_method, provider_params
  ) values (
    p_attempt_token, p_resident_user_id, lower(trim(p_resident_email)), p_manager_user_id,
    p_charge_ids, p_charge_cents, p_subtotal_cents, p_payer_total_cents,
    p_recipient_net_cents, p_payment_method, p_provider_params
  ) returning * into v_attempt;
  for v_id in select id from unnest(p_charge_ids) id order by id loop
    insert into public.resident_charge_payment_slots(charge_id, checkout_attempt_id)
      values(v_id, v_attempt.id);
  end loop;
  return v_attempt;
end;
$$;

revoke all on function public.reserve_resident_checkout_attempt(uuid,uuid,text,uuid,text[],integer[],integer,integer,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_resident_checkout_attempt(uuid,uuid,text,uuid,text[],integer[],integer,integer,integer,text,jsonb) to service_role;
