import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateEvidencePolicy, type EvidencePolicy } from "@/lib/resident-evidence/policy";
const policy: EvidencePolicy = { id: "policy", property_id: "home", manager_user_id: "manager", version: 1, application_requirement: "both", tour_requirement: "id", short_stay_requirement: "id", jurisdiction_state: "WA", jurisdiction_city: "Seattle", legal_review_reference: "review-1", legal_approved: true, identity_max_age_days: 365, screening_products: ["credit", "eviction"], tour_background_purpose_approved: false };
const base = { enabled: true, propertyId: "home", purpose: "tour" as const, property: { manager_user_id: "manager", property_data: { address: "10 Main St", state: "WA", city: "Seattle", zip: "98101" } }, policy, identity: { status: "approved", verified_at: "2026-10-01T00:00:00Z" }, personaConfigured: true, now: Date.parse("2026-10-29T00:00:00Z") };
describe("resident evidence policy", () => {
  it("preserves existing behavior while rollout is off", () => expect(evaluateEvidencePolicy({ ...base, enabled: false, property: null, policy: null })).toEqual({ kind: "disabled" }));
  it("accepts a current persisted attestation without provider keys", () => expect(evaluateEvidencePolicy({ ...base, personaConfigured: false })).toMatchObject({ kind: "resolved", identity: "verified", allowed: true, version: 1, requirement: "id" }));
  it("fails closed when verification is needed and Persona is unavailable", () => expect(evaluateEvidencePolicy({ ...base, personaConfigured: false, identity: null })).toEqual({ kind: "unavailable", reason: "identity_provider_unavailable" }));
  it("distinguishes expired from missing identity", () => {
    expect(evaluateEvidencePolicy({ ...base, identity: { status: "approved", verified_at: "2020-01-01T00:00:00Z" } })).toMatchObject({ kind: "resolved", identity: "expired", allowed: false });
    expect(evaluateEvidencePolicy({ ...base, identity: { status: "review", verified_at: null } })).toMatchObject({ kind: "resolved", identity: "missing", allowed: false });
  });
  it("refuses unknown jurisdiction or legal authorization", () => {
    expect(evaluateEvidencePolicy({ ...base, property: { ...base.property, property_data: { address: "10 Main", zip: "98101" } } })).toMatchObject({ kind: "unavailable", reason: "jurisdiction_or_legal_review_unknown" });
    expect(evaluateEvidencePolicy({ ...base, policy: { ...policy, legal_approved: false } })).toMatchObject({ kind: "unavailable" });
  });
  it("blocks unapproved tour screening and never claims a background check is complete", () => {
    expect(evaluateEvidencePolicy({ ...base, policy: { ...policy, tour_requirement: "both" } })).toMatchObject({ kind: "unavailable", reason: "tour_purpose_unapproved" });
    expect(evaluateEvidencePolicy({ ...base, purpose: "application" })).toMatchObject({ kind: "resolved", background: "unavailable", allowed: false });
    expect(evaluateEvidencePolicy({ ...base, purpose: "application", policy: { ...policy, screening_products: [] } })).toMatchObject({ kind: "unavailable", reason: "screening_products_unknown" });
  });
  it("stores immutable versions with owner-only client reads", () => {
    const sql = readFileSync("supabase/migrations/20261030130000_resident_evidence_policies.sql", "utf8");
    expect(sql).toContain("unique (property_id, version)");
    expect(sql).toContain("before update on public.resident_evidence_policies");
    expect(sql).toContain("p.manager_user_id = auth.uid()");
    expect(sql).toContain("revoke all on public.resident_evidence_policies from public, anon, authenticated");
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/i);
  });
});
