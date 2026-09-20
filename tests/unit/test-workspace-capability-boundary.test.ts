import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCapability = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/sms-test-context.server", () => ({
  resolveSmsTestCapability: resolveCapability,
}));

import { GET } from "@/app/api/agent/sms-test/capability/route";

beforeEach(() => vi.clearAllMocks());

describe("SMS test workspace capability boundary", () => {
  it("uses a uniform private denial for an ordinary or forged workspace request", async () => {
    resolveCapability.mockResolvedValue(null);
    const response = await GET(new Request(
      "https://prop-lane.test/api/agent/sms-test/capability?portal=resident&workspaceId=forged-workspace",
    ));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
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
