import { afterEach, describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resident-identity/auth.server", () => ({ residentIdentityActor: actor }));
import { GET } from "@/app/api/resident/identity/route";
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; actor.mockReset(); });
describe("resident identity status", () => {
  it("returns an existing verified attestation when provider configuration is absent", async () => {
    delete process.env.RESIDENT_IDENTITY_ENABLED;
    delete process.env.PERSONA_API_KEY;
    const query = (value: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value, error: null }), in: () => ({ maybeSingle: async () => ({ data: value, error: null }) }) }) }) });
    actor.mockResolvedValue({ userId: "resident", db: { from: (table: string) => query(table === "resident_identity_subjects" ? { status: "approved", verified_at: "2026-10-29T00:00:00Z" } : null) } });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "approved", provider: "Persona", verifiedAt: "2026-10-29T00:00:00Z" });
  });
  it("rejects an unauthenticated request", async () => {
    actor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
