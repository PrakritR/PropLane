-- ---------------------------------------------------------------------------------------------
-- activate_managed_policy: the signature guard covers EVERY term the owner signed (canonical v3).
--
-- 20261020150000 compared exactly the fields `canonicalPolicyTerms` v2 hashed, so it was self-consistent - but
-- `repair_approval_threshold_cents` and `reserve_target_cents` sat outside both. The threshold is what decides
-- whether a vendor bill is posted against the owner WITHOUT asking her (`vendor-bills.server.ts`), so an admin
-- raising it between her page's load and her signature still activated it under that signature.
--
-- Canonical v3 includes both, and so does this comparison. Values are compared as text, so a malformed snapshot
-- refuses instead of raising a cast error.
-- ---------------------------------------------------------------------------------------------
create or replace function public.activate_managed_policy(
  p_id uuid, p_via text, p_note text, p_hash text, p_snapshot jsonb, p_actor_role text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pol public.managed_workspace_fee_policies%rowtype;
begin
  if p_via not in ('owner_signature', 'admin_attested') or p_actor_role not in ('admin', 'owner', 'system') then
    return jsonb_build_object('status', 'refused', 'reason', 'bad_request');
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    return jsonb_build_object('status', 'refused', 'reason', 'bad_request');
  end if;
  select * into v_pol from public.managed_workspace_fee_policies where id = p_id for update;
  if not found then return jsonb_build_object('status', 'refused', 'reason', 'not_found'); end if;
  if v_pol.status = 'active' and v_pol.signed_at is not null then return jsonb_build_object('status', 'exists'); end if;
  if v_pol.status <> 'draft' then return jsonb_build_object('status', 'refused', 'reason', 'not_draft'); end if;
  if v_pol.effective_from > current_date then return jsonb_build_object('status', 'refused', 'reason', 'future_effective_from'); end if;
  -- An owner can only sign something that was sent to them.
  if p_via = 'owner_signature' and v_pol.sent_at is null then
    return jsonb_build_object('status', 'refused', 'reason', 'not_sent');
  end if;
  -- The signed terms must still BE this row's terms - every one of them.
  if (p_snapshot->>'workspaceId') is distinct from v_pol.workspace_id::text
     or (p_snapshot->>'ownerUserId') is distinct from v_pol.owner_user_id::text
     or (p_snapshot->>'ownerShareBps') is distinct from v_pol.owner_share_bps::text
     or (p_snapshot->>'appliesTo') is distinct from v_pol.applies_to::text
     or (p_snapshot->>'leasingFeeBps') is distinct from v_pol.leasing_fee_bps::text
     or (p_snapshot->>'minFeeCents') is distinct from v_pol.min_fee_cents::text
     or (p_snapshot->>'reserveTargetCents') is distinct from v_pol.reserve_target_cents::text
     or (p_snapshot->>'repairApprovalThresholdCents') is distinct from v_pol.repair_approval_threshold_cents::text
     or (p_snapshot->>'effectiveFrom') is distinct from to_char(v_pol.effective_from, 'YYYY-MM-DD')
  then
    return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
  end if;
  update public.managed_workspace_fee_policies
    set status = 'ended', ended_at = now(), ended_by_role = 'system', ends_on = greatest(current_date, effective_from), updated_at = now()
    where workspace_id = v_pol.workspace_id and status = 'active' and id <> p_id;
  update public.managed_workspace_fee_policies
    set status = 'active', signed_at = now(), accepted_via = p_via, attestation_note = nullif(trim(coalesce(p_note, '')), ''),
        terms_sha256 = p_hash, terms_snapshot = p_snapshot, updated_at = now()
    where id = p_id;
  return jsonb_build_object('status', 'active');
end;
$$;

revoke all on function public.activate_managed_policy(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.activate_managed_policy(uuid, text, text, text, jsonb, text) to service_role;
