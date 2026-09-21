import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  serviceClient: vi.fn(),
  userIsManager: vi.fn(),
  loadWorkspaces: vi.fn(),
  loadWorkspacePlan: vi.fn(),
  businessAccess: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.serverClient }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/auth/co-manager-invite-eligibility.server", () => ({
  userIsPropertyPortalManager: mocks.userIsManager,
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: mocks.loadWorkspaces,
  loadWorkspacePlan: mocks.loadWorkspacePlan,
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: mocks.businessAccess,
}));

import { GET, POST } from "@/app/api/workspaces/route";

const OWNER = "owner-123";
const OTHER = "attacker-456";
const DEFAULT = "default-workspace";
const NEW = "new-workspace";

const plan = {
  tier: "pro",
  unknown: false,
  workspaceLimit: 2,
  propertyLimit: 2,
  recordsPerWorkspace: 10,
  teamLimit: 2,
  usage: { workspaces: 1, properties: 0, team: 0, vendors: 0 },
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function setup(options: { user?: { id: string } | null; planValue?: unknown } = {}) {
  const user = options.user === undefined ? { id: OWNER } : options.user;
  const db = { rpc: mocks.rpc };
  mocks.serverClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user } })) } });
  mocks.serviceClient.mockReturnValue(db);
  mocks.userIsManager.mockResolvedValue(Boolean(user));
  mocks.businessAccess.mockResolvedValue({ kind: "normal" });
  mocks.loadWorkspaces.mockResolvedValue([
    {
      id: DEFAULT,
      name: "My workspace",
      ownerUserId: OWNER,
      owned: true,
      isDefault: true,
      propertyIds: [],
      propertyPermissions: {},
    },
  ]);
  mocks.loadWorkspacePlan.mockResolvedValue(options.planValue ?? plan);
  mocks.rpc.mockResolvedValue({ data: NEW, error: null });
  return db;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace create route owner and cap contract", () => {
  it("rejects unauthenticated creation before service RPC", async () => {
    setup({ user: null });

    const response = await POST(request({ action: "create", name: "No access" }));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { state: "suspended" },
    { state: "expired" },
    { state: "flag-off" },
  ])("refuses a %s classified session before workspace reads or service RPCs", async ({ state }) => {
    setup();
    mocks.businessAccess.mockResolvedValue({ kind: "denied", state });

    const readResponse = await GET();
    const writeResponse = await POST(request({ action: "initialize" }));

    expect(readResponse.status).toBe(403);
    expect(writeResponse.status).toBe(403);
    expect(mocks.loadWorkspaces).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("allows a normal authenticated session through the workspace service boundary", async () => {
    setup();

    const response = await POST(request({ action: "initialize" }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_default_portal_workspace", { p_owner: OWNER });
  });

  it.each([
    { name: "", reason: "empty" },
    { name: "x".repeat(81), reason: "too long" },
  ])("rejects an invalid $reason name before any RPC", async ({ name }) => {
    setup();

    const response = await POST(request({ action: "create", name, owner_user_id: OTHER }));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("derives the authenticated owner and server plan cap, ignoring an owner in the body", async () => {
    setup();

    const response = await POST(request({
      action: "create",
      name: "Leasing team",
      owner_user_id: OTHER,
      cap: 10_000,
    }));

    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    const createCall = mocks.rpc.mock.calls[0];
    expect(createCall?.[0]).toBe("create_portal_workspace_with_limit");
    expect(createCall?.[1]).toMatchObject({
      p_owner: OWNER,
      p_name: "Leasing team",
      p_limit: plan.workspaceLimit,
    });
    expect(createCall?.[1]).not.toHaveProperty("owner_user_id");
  });

  it("fails closed when the workspace plan is unknown after an add-on read failure", async () => {
    setup({ planValue: { ...plan, unknown: true } });

    const response = await POST(request({ action: "create", name: "Unknown capacity" }));
    const body = await json(response);

    expect(response.status).toBe(503);
    expect(body.error).toMatch(/could not verify your plan/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps the atomic RPC race refusal to a conflict", async () => {
    setup();
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const response = await POST(request({ action: "create", name: "Final slot" }));
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/workspace|limit|reached|another/i);
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
});
