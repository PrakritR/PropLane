import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/pro/workspaces/[workspaceId]/transfer-ownership` contract: the
 * caller is authenticated from the session (never the body), the lib's
 * status/error pass straight through, and a success returns the lib's shape.
 */
const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  serviceClient: vi.fn(),
  transferWorkspaceOwnership: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.serverClient }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/workspace-ownership-transfer", () => ({
  transferWorkspaceOwnership: mocks.transferWorkspaceOwnership,
}));

import { POST } from "@/app/api/pro/workspaces/[workspaceId]/transfer-ownership/route";

const OWNER = "owner-123";

function request(body: unknown): Request {
  return new Request("http://localhost/api/pro/workspaces/ws-1/transfer-ownership", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function ctx(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function setup(user: { id: string } | null = { id: OWNER }) {
  mocks.serverClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user } })) } });
  mocks.serviceClient.mockReturnValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace transfer-ownership route contract", () => {
  it("401s with no session", async () => {
    setup(null);
    const response = await POST(request({ newOwnerUserId: "member-1" }), ctx());
    expect(response.status).toBe(401);
    expect(mocks.transferWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("400s when newOwnerUserId is missing", async () => {
    setup();
    const response = await POST(request({}), ctx());
    expect(response.status).toBe(400);
    expect(mocks.transferWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("derives currentOwnerUserId from the session, never the body", async () => {
    setup();
    mocks.transferWorkspaceOwnership.mockResolvedValue({
      ok: true,
      houses: 2,
      members: 1,
      workspaceName: "Acme Portfolio",
    });
    await POST(request({ newOwnerUserId: "member-1", currentOwnerUserId: "attacker" }), ctx());
    expect(mocks.transferWorkspaceOwnership).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "ws-1",
        currentOwnerUserId: OWNER,
        newOwnerUserId: "member-1",
      }),
    );
  });

  it("defaults formerOwnerRole to admin and passes through a valid role", async () => {
    setup();
    mocks.transferWorkspaceOwnership.mockResolvedValue({
      ok: true,
      houses: 0,
      members: 0,
      workspaceName: "Acme Portfolio",
    });
    await POST(request({ newOwnerUserId: "member-1" }), ctx());
    expect(mocks.transferWorkspaceOwnership.mock.calls[0]?.[1]).toMatchObject({ formerOwnerRole: "admin" });

    await POST(request({ newOwnerUserId: "member-1", formerOwnerRole: "nothing" }), ctx());
    expect(mocks.transferWorkspaceOwnership.mock.calls[1]?.[1]).toMatchObject({ formerOwnerRole: "nothing" });

    // An unrecognized role falls back to admin rather than passing junk through.
    await POST(request({ newOwnerUserId: "member-1", formerOwnerRole: "owner" }), ctx());
    expect(mocks.transferWorkspaceOwnership.mock.calls[2]?.[1]).toMatchObject({ formerOwnerRole: "admin" });
  });

  it("passes the lib's status and error straight through on failure", async () => {
    setup();
    mocks.transferWorkspaceOwnership.mockResolvedValue({
      ok: false,
      error: "That person isn't a member of this workspace.",
      status: 404,
    });
    const response = await POST(request({ newOwnerUserId: "member-1" }), ctx());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That person isn't a member of this workspace." });
  });

  it("returns the 200 shape on success", async () => {
    setup();
    mocks.transferWorkspaceOwnership.mockResolvedValue({
      ok: true,
      houses: 3,
      members: 2,
      workspaceName: "Acme Portfolio",
    });
    const response = await POST(request({ newOwnerUserId: "member-1" }), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      houses: 3,
      members: 2,
      workspaceName: "Acme Portfolio",
    });
  });
});
