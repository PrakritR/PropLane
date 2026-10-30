import { afterEach, describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resident-identity/auth.server", () => ({ residentIdentityActor: actor }));
vi.mock("@/lib/resident-identity/persona.server", () => ({ personaEnabled: () => true }));
import { POST } from "@/app/api/resident/identity/retry/route";
afterEach(() => actor.mockReset());
describe("identity retry authorization", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    actor.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
  });
  it("uses the authenticated resident, never a request-supplied identity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    actor.mockResolvedValue({ userId: "resident", db: { rpc } });
    expect((await POST()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("retry_expired_resident_identity", { p_resident_user_id: "resident" });
  });
});
