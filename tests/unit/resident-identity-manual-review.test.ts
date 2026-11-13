import { afterEach, describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resident-identity/auth.server", () => ({ residentIdentityActor: actor }));
import { POST } from "@/app/api/resident/identity/manual-review/route";
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; actor.mockReset(); });
describe("manual identity review", () => {
  it("returns the tracked request id without granting verification", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona";
    const insert = vi.fn(() => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "review-1" }, error: null }) }) }));
    const db = { from: (table: string) => table === "resident_identity_subjects" ? { upsert: async () => ({ error: null }) } : { insert } };
    actor.mockResolvedValue({ userId: "resident", db });
    const response = await POST();
    expect(await response.json()).toEqual({ status: "requested", reviewId: "review-1" });
    expect(insert).toHaveBeenCalledWith({ resident_user_id: "resident" });
  });
});
