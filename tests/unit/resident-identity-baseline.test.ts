import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { resolveBaselineResidentIdentity } from "@/lib/resident-identity/baseline.server";
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
const db = (value: unknown, error: unknown = null) => ({ from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value, error }) }) }) })) }) as unknown as SupabaseClient;
describe("baseline identity", () => {
  it("does no storage reads when disabled", async () => {
    delete process.env.RESIDENT_IDENTITY_ENABLED;
    const client = db(null); expect(await resolveBaselineResidentIdentity(client, "resident")).toBe("disabled"); expect(client.from).not.toHaveBeenCalled();
  });
  it("retains a provider-approved attestation when provider configuration is unavailable", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona"; delete process.env.PERSONA_API_KEY;
    expect(await resolveBaselineResidentIdentity(db({ status: "approved", provider_decision: "approved", verified_at: "2026-01-01T00:00:00Z" }), "resident")).toBe("verified");
  });
  it("fails closed for missing, completed, malformed or unreadable evidence", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona"; delete process.env.PERSONA_API_KEY;
    expect(await resolveBaselineResidentIdentity(db(null), null)).toBe("unavailable");
    expect(await resolveBaselineResidentIdentity(db({ status: "review", verified_at: null }), "resident")).toBe("unavailable");
    expect(await resolveBaselineResidentIdentity(db(null, {}), "resident")).toBe("unavailable");
    process.env.PERSONA_API_KEY = "key"; process.env.PERSONA_TEMPLATE_ID = "template"; process.env.PERSONA_WEBHOOK_SECRET = "secret";
    expect(await resolveBaselineResidentIdentity(db({ status: "review", verified_at: null }), "resident")).toBe("required");
  });
});
