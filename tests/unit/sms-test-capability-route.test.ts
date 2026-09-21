import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveCapability } = vi.hoisted(() => ({ resolveCapability: vi.fn() }));
vi.mock("@/lib/agent/sms-test-context.server", () => ({
  resolveSmsTestCapability: resolveCapability,
}));

import { GET } from "@/app/api/agent/sms-test/capability/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SMS test capability route", () => {
  it("accepts only the server-known portal names", async () => {
    const response = await GET(new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=vendor"));
    expect(response.status).toBe(400);
    expect(resolveCapability).not.toHaveBeenCalled();
  });

  it("returns only the capability produced by the authenticated resolver", async () => {
    resolveCapability.mockResolvedValue({
      enabled: true,
      portal: "resident",
      actorUserId: "actor-1",
      actorName: "Alex",
      targets: [{ listingId: "listing-1", managerUserId: "manager-1", title: "Oak", address: "1 Oak" }],
    });
    const response = await GET(new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=resident"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ capability: { actorUserId: "actor-1" } });
    expect(resolveCapability).toHaveBeenCalledWith("resident");
  });

  it("hides both unauthorized actors and production-gate failures", async () => {
    resolveCapability.mockResolvedValueOnce(null);
    const unauthorized = await GET(new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=manager"));
    expect(unauthorized.status).toBe(404);

    resolveCapability.mockRejectedValueOnce(new Error("available only against an approved non-production database"));
    const production = await GET(new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=manager"));
    expect(production.status).toBe(404);
    expect(await production.json()).toEqual({ error: "Not found." });
  });
});
