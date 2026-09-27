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

  it("hides both unauthorized actors and production-gate failures behind the same ok, null-capability response", async () => {
    // Commit 7a5e1168 ("stop the SMS-test capability probe from 404ing as a
    // normal response") moved this from a 404 to a 200 with { capability:
    // null } for BOTH cases (Night QA finding #9: the assistant widget probes
    // this on effectively every portal page mount, and "not eligible" — nearly
    // every account — was reading as a broken endpoint in the network log).
    // The security invariant this test guards is unchanged: an unauthorized
    // actor and a production-gate failure must still be indistinguishable from
    // each other and from the ordinary "not a test-workspace member" case —
    // they were merged into 404 before, now into a uniform 200/null.
    resolveCapability.mockResolvedValueOnce(null);
    const unauthorized = await GET(
      new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=manager"),
    );
    expect(unauthorized.status).toBe(200);
    expect(await unauthorized.json()).toEqual({ capability: null });

    resolveCapability.mockRejectedValueOnce(new Error("available only against an approved non-production database"));
    const production = await GET(
      new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=manager"),
    );
    expect(production.status).toBe(200);
    expect(await production.json()).toEqual({ capability: null });
  });

  it("still fails loudly on a genuine lookup error, distinct from the hidden not-eligible/production-gate cases", async () => {
    resolveCapability.mockRejectedValueOnce(new Error("database connection reset"));
    const response = await GET(
      new Request("https://prop-lane.test/api/agent/sms-test/capability?portal=manager"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not check SMS test access." });
  });
});
