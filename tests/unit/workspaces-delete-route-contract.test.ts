import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/workspaces { action: "delete" }` contract: any owned workspace can
 * go (the default one included), the owner and the destination for its houses
 * are re-derived server-side, and the database routine owns the move + delete.
 */
const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  serviceClient: vi.fn(),
  userIsManager: vi.fn(),
  loadWorkspaces: vi.fn(),
  loadWorkspacePlan: vi.fn(),
  businessAccess: vi.fn(),
  rpc: vi.fn(),
  ownedRows: new Map<string, { id: string }>(),
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

import { POST } from "@/app/api/workspaces/route";

const OWNER = "owner-123";
const DEFAULT = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";

function request(body: unknown): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** A `from("portal_workspaces").select().eq().eq().maybeSingle()` chain that answers from the owner's rows. */
function ownedLookup() {
  const filters: Record<string, string> = {};
  const chain = {
    select: () => chain,
    eq: (column: string, value: string) => {
      filters[column] = value;
      return chain;
    },
    maybeSingle: async () => {
      const row = mocks.ownedRows.get(filters.id ?? "");
      return { data: row && filters.owner_user_id === OWNER ? row : null, error: null };
    },
  };
  return chain;
}

function setup() {
  const db = { rpc: mocks.rpc, from: vi.fn(() => ownedLookup()) };
  mocks.serverClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: OWNER } } })) } });
  mocks.serviceClient.mockReturnValue(db);
  mocks.userIsManager.mockResolvedValue(true);
  mocks.businessAccess.mockResolvedValue({ kind: "normal" });
  mocks.ownedRows.clear();
  mocks.ownedRows.set(DEFAULT, { id: DEFAULT });
  mocks.ownedRows.set(SECOND, { id: SECOND });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace delete route contract", () => {
  it("deletes the default workspace like any other, with the owner derived from the session", async () => {
    setup();
    const response = await POST(request({ action: "delete", id: DEFAULT, owner_user_id: "attacker" }));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls[0]?.[0]).toBe("delete_portal_workspace");
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_owner: OWNER, p_id: DEFAULT, p_move_to: null });
  });

  it("forwards an owned destination for the houses", async () => {
    setup();
    const response = await POST(request({ action: "delete", id: DEFAULT, moveTo: SECOND }));
    expect(response.status).toBe(200);
    expect(mocks.rpc.mock.calls[0]?.[1]).toEqual({ p_owner: OWNER, p_id: DEFAULT, p_move_to: SECOND });
  });

  it("refuses a destination the owner does not hold, or the workspace itself, before the database", async () => {
    setup();
    const foreign = await POST(request({ action: "delete", id: DEFAULT, moveTo: FOREIGN }));
    expect(foreign.status).toBe(400);
    const self = await POST(request({ action: "delete", id: DEFAULT, moveTo: DEFAULT }));
    expect(self.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps houses left behind to the move-first conflict", async () => {
    setup();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23503", message: "fk" } });
    const response = await POST(request({ action: "delete", id: SECOND }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/move the properties out/i);
  });

  it("refuses a workspace the caller does not own", async () => {
    setup();
    const response = await POST(request({ action: "delete", id: FOREIGN }));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
