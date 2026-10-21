-- ---------------------------------------------------------------------------------------------
-- activate_managed_policy: a SYSTEM activation never ends a version an admin just committed.
--
-- `ensureServiceFeePolicy` drafts and activates the default 10% fee lazily, with `p_actor_role = 'system'`, and it
-- only does so because the resolver read NO policy in force a moment earlier. That read is not under this
-- function's lock, so an admin recording a hand-authored version in Admin > Managed finance in between left the
-- system activation ending the admin's rate and replacing it with the default - a silent rate change nobody asked
-- for, on PropLane's own revenue.
--
-- So the `ends the previous version` step is now an ADMIN-only power. A system activation re-checks, under the row
-- lock, that the workspace still has no accepted version in force, and refuses with `already_active` when it does;
-- `ensureServiceFeePolicy` re-reads on a refusal and answers with the version that won, and takes its own unsigned
-- draft back out. An admin's own activation is unchanged: recording a new version is exactly how a rate is changed.
-- ---------------------------------------------------------------------------------------------
create or replace function public.activate_managed_policy(
  p_id uuid, p_via text, p_note text, p_hash text, p_snapshot jsonb, p_actor_role text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pol public.managed_workspace_fee_policies%rowtype;
  -- The column defaults a canonical-v2 draft was created with.
  c_reserve_default constant integer := 0;
  c_threshold_default constant integer := 25000;
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
  -- The automatic fee only fills a GAP. Re-checked here, after the lock, because the caller's own read of "no policy
  -- in force" is older than this transaction: the version an admin committed since then is the one that stands.
  if p_actor_role = 'system' and exists (
    select 1 from public.managed_workspace_fee_policies
     where workspace_id = v_pol.workspace_id and status = 'active' and signed_at is not null and id <> p_id
  ) then
    return jsonb_build_object('status', 'refused', 'reason', 'already_active');
  end if;
  -- The signed terms must still BE this row's terms - every one the snapshot names.
  if (p_snapshot->>'workspaceId') is distinct from v_pol.workspace_id::text
     or (p_snapshot->>'ownerUserId') is distinct from v_pol.owner_user_id::text
     or (p_snapshot->>'ownerShareBps') is distinct from v_pol.owner_share_bps::text
     or (p_snapshot->>'appliesTo') is distinct from v_pol.applies_to::text
     or (p_snapshot->>'leasingFeeBps') is distinct from v_pol.leasing_fee_bps::text
     or (p_snapshot->>'minFeeCents') is distinct from v_pol.min_fee_cents::text
     or (p_snapshot->>'effectiveFrom') is distinct from to_char(v_pol.effective_from, 'YYYY-MM-DD')
  then
    return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
  end if;
  -- v3 terms: compared when the snapshot names them, else allowed only on the column's own default.
  if p_snapshot ? 'reserveTargetCents' then
    if (p_snapshot->>'reserveTargetCents') is distinct from v_pol.reserve_target_cents::text then
      return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
    end if;
  elsif v_pol.reserve_target_cents is distinct from c_reserve_default then
    return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
  end if;
  if p_snapshot ? 'repairApprovalThresholdCents' then
    if (p_snapshot->>'repairApprovalThresholdCents') is distinct from v_pol.repair_approval_threshold_cents::text then
      return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
    end if;
  elsif v_pol.repair_approval_threshold_cents is distinct from c_threshold_default then
    return jsonb_build_object('status', 'refused', 'reason', 'terms_changed');
  end if;
  -- Only an admin's own activation replaces the version in force; a system one has refused above if there is one.
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
