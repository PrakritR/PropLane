import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030144100_tour_capability_claim_retry.sql", "utf8");
describe("tour capability claim retry migration", () => {
  it("serializes the capability and only reuses the identical live pending handoff", () => {
    expect(sql).toMatch(/expires_at > now\(\) for update/);
    expect(sql).toContain("on conflict (token_digest) do nothing");
    for (const condition of ["handoff.user_id is distinct from p_user_id", "handoff.tour_capability_id is distinct from cap.id", "handoff.intent is distinct from 'tour'", "handoff.tour_inquiry_id is distinct from p_inquiry_id", "handoff.status is distinct from 'pending'", "handoff.expires_at <= now()", "consumed_user_id is null or consumed_user_id = p_user_id"]) expect(sql).toContain(condition);
    expect(sql.indexOf("handoff.expires_at <= now() then return false")).toBeLessThan(sql.indexOf("update public.tour_signup_capabilities set"));
    expect(sql).not.toMatch(/update public\.email_onboarding_handoffs/);
    expect(sql).toContain("from public, anon, authenticated");
  });
});
