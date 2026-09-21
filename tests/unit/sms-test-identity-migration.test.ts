import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260917120000_authenticated_sms_test_identity.sql"),
  "utf8",
).toLowerCase();

describe("authenticated SMS test identity migration", () => {
  it("keeps live phone identity and authenticated test identity mutually exclusive", () => {
    expect(migration).toContain("add constraint prospect_sms_bursts_identity_xor_check");
    expect(migration).toContain("identity_kind='live_phone'");
    expect(migration).toContain("counterparty_phone_e164 is null");
    expect(migration).toContain("test_actor_user_id is not null");
    expect(migration).toContain("reply_transport='in_app_test'");
    expect(migration).toContain("reply_from_number is null");
    expect(migration).toContain("channel='in_app_test' and test_actor_user_id is not null");
    expect(migration).toContain("channel in ('twilio','claw') and test_actor_user_id is null");
  });

  it("reuses revisioned ingress and actor-bound claim/completion fences", () => {
    expect(migration).toContain("create or replace function public.record_authenticated_sms_test_ingress");
    expect(migration).toContain("create or replace function public.claim_authenticated_sms_test_burst");
    expect(migration).toContain("create or replace function public.complete_authenticated_sms_test_burst");
    expect(migration).toContain("v_burst.revision+1");
    expect(migration).toContain("p_identity_kind='authenticated_test' and i.test_actor_user_id=p_test_actor_user_id");
    expect(migration).toContain("and identity_kind='authenticated_test' and test_actor_user_id=p_test_actor_user_id");
    expect(migration).toContain("and status='generating'");
    expect(migration).toContain("and lease_owner=p_worker_id and lease_expires_at>now()");
  });

  it("preserves offer, agreement-source, revision, and idempotency checks for test tour booking", () => {
    expect(migration).toContain("create or replace function public.prepare_authenticated_sms_test_tour_offer");
    expect(migration).toContain("create or replace function public.confirm_authenticated_sms_test_tour_offer");
    expect(migration).toContain("where idempotency_key=p_idempotency_key and manager_user_id=p_manager_user_id");
    expect(migration).toContain("v_burst.revision<>p_burst_revision");
    expect(migration).toContain("v_burst.consumed_source_ids is distinct from to_jsonb(p_claimed_source_ids)");
    expect(migration).toContain("p_agreement_source_message_id=any(p_claimed_source_ids)");
    expect(migration).toContain("return jsonb_build_object('ok',false,'reason','stale_agreement')");
    expect(migration).toContain("return jsonb_build_object('ok',false,'reason','offer_not_submitted')");
    expect(migration).toContain("'captured','suppressed','skipped',p_test_actor_user_id");
  });

  it("keeps every new RPC service-role only", () => {
    for (const fn of [
      "record_authenticated_sms_test_ingress",
      "claim_authenticated_sms_test_burst",
      "complete_authenticated_sms_test_burst",
      "prepare_authenticated_sms_test_tour_offer",
      "confirm_authenticated_sms_test_tour_offer",
    ]) {
      expect(migration).toContain(`revoke execute on function public.${fn}`);
      expect(migration).toContain(`grant execute on function public.${fn}`);
    }
    expect(migration).toContain("to service_role");
  });
});
