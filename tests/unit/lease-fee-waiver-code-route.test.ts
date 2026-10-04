/**
 * The resident's waive-code route: who may call it, what it forwards, and how a refusal is reported. The money
 * rules themselves are tested against real Postgres in lease-fee-waive-code-redemption.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "u-resident", email: "signer@example.com" } as { id: string; email: string } | null,
  isResident: true,
  limited: false,
  redeem: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "signer@example.com", role: "resident" } }) }) }),
    }),
  }),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => h.isResident }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: !h.limited }) }));
vi.mock("@/lib/lease-fee-waiver.server", () => ({ redeemLeaseFeeWaiverCode: h.redeem }));

import { POST } from "@/app/api/resident/lease-fee-waiver-code/route";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/resident/lease-fee-waiver-code", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  h.user = { id: "u-resident", email: "signer@example.com" };
  h.isResident = true;
  h.limited = false;
  h.redeem.mockReset();
});

describe("POST /api/resident/lease-fee-waiver-code", () => {
  it("is for signed-in residents only", async () => {
    h.user = null;
    expect((await post({ leaseId: "l1", code: "ABCD" })).status).toBe(401);
    h.user = { id: "u-manager", email: "m@example.com" };
    h.isResident = false;
    expect((await post({ leaseId: "l1", code: "ABCD" })).status).toBe(403);
    expect(h.redeem).not.toHaveBeenCalled();
  });

  it("needs a lease and a code", async () => {
    expect((await post({ leaseId: "l1" })).status).toBe(400);
    expect((await post({ code: "ABCD" })).status).toBe(400);
    expect(h.redeem).not.toHaveBeenCalled();
  });

  it("is rate limited per resident", async () => {
    h.limited = true;
    expect((await post({ leaseId: "l1", code: "ABCD" })).status).toBe(429);
    expect(h.redeem).not.toHaveBeenCalled();
  });

  it("forwards the SESSION's identity and only the lease id and code from the body", async () => {
    h.redeem.mockResolvedValue({ ok: true, alreadyWaived: false, applicationIds: [], cancelledChargeIds: ["c1"] });
    const res = await post({
      leaseId: "l1",
      code: " spring25 ",
      managerUserId: "attacker",
      propertyId: "other",
      residentEmail: "victim@example.com",
      amount: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, waived: true, alreadyWaived: false });
    expect(h.redeem).toHaveBeenCalledTimes(1);
    expect(h.redeem.mock.calls[0]![1]).toEqual({
      residentUserId: "u-resident",
      residentEmail: "signer@example.com",
      leaseId: "l1",
      code: "spring25",
    });
  });

  it("reports a refusal with its status, message and reason", async () => {
    h.redeem.mockResolvedValue({ ok: false, status: 409, reason: "ALREADY_PAID", error: "The lease fee was already paid." });
    const res = await post({ leaseId: "l1", code: "ABCD" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The lease fee was already paid.", code: "ALREADY_PAID" });
  });

  it("never leaks a thrown error's text", async () => {
    h.redeem.mockRejectedValue(new Error("relation portal_lease_pipeline_records does not exist"));
    const res = await post({ leaseId: "l1", code: "ABCD" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});
