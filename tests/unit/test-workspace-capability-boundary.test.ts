import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCapability = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/sms-test-context.server", () => ({
  resolveSmsTestCapability: resolveCapability,
}));

import { GET } from "@/app/api/agent/sms-test/capability/route";

beforeEach(() => vi.clearAllMocks());

describe("SMS test workspace capability boundary", () => {
  it("uses a uniform private denial for an ordinary or forged workspace request", async () => {
    // Commit 7a5e1168 ("stop the SMS-test capability probe from 404ing as a
    // normal response") moved the "no capability" case from a 404 to a 200
    // with { capability: null } — the assistant widget probes this route on
    // effectively every portal page mount, and "not eligible" (nearly every
    // account) was reading as a broken endpoint in the network log. The
    // boundary this test guards is unaffected: a forged workspaceId is still
    // never consulted (resolveSmsTestCapability is called with the portal
    // alone), and the denial is still uniform and still private/no-store —
    // only the shared envelope for "no capability" changed shape.
    resolveCapability.mockResolvedValue(null);
    const response = await GET(new Request(
      "https://prop-lane.test/api/agent/sms-test/capability?portal=resident&workspaceId=forged-workspace",
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ capability: null });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(resolveCapability).toHaveBeenCalledWith("resident");
  });

  it("never accepts workspace identity from client query metadata", async () => {
    resolveCapability.mockResolvedValue({
      enabled: true,
      portal: "resident",
      actorUserId: "actor-a",
      actorName: "Resident",
      targets: [],
      workspaceId: "server-workspace",
    });
    const response = await GET(new Request(
      "https://prop-lane.test/api/agent/sms-test/capability?portal=resident&workspaceId=other-workspace",
    ));

    expect(response.status).toBe(200);
    expect((await response.json()).capability.workspaceId).toBe("server-workspace");
    expect(resolveCapability).toHaveBeenCalledWith("resident");
  });
});
