/**
 * Moving a house OUT of a PropLane-managed (view-only) workspace is a write on that workspace, so
 * `/api/workspaces` refuses it. The source-workspace read behind that check used to ignore its own error, which
 * made the one lock that matters fail OPEN: a transient read error let the house out of the locked workspace,
 * which is exactly the bypass the block exists to close. `/api/workspaces` is on the middleware allowlist, so
 * these route checks are the only gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/property-owner/access.server", () => ({
  ownerAccessStateFor: async () => ({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false }),
}));

const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  serviceClient: vi.fn(),
  userIsManager: vi.fn(),
  loadWorkspaces: vi.fn(),
  loadWorkspacePlan: vi.fn(),
  businessAccess: vi.fn(),
  lockedIds: vi.fn(async () => [] as string[]),
  standing: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: vi.fn(() => undefined) })) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.serverClient }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/auth/co-manager-invite-eligibility.server", () => ({ userIsPropertyPortalManager: mocks.userIsManager }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces, loadWorkspacePlan: mocks.loadWorkspacePlan }));
vi.mock("@/lib/auth/managed-read-only.server", () => ({ managedReadOnlyWorkspaceIds: mocks.lockedIds }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: mocks.businessAccess }));
vi.mock("@/lib/workspaces/membership.server", () => ({
  actorWorkspaceStanding: mocks.standing,
  previewHouseMove: mocks.preview,
}));

import { POST } from "@/app/api/workspaces/route";

const OWNER = "owner-123";
const LOCKED = "11111111-1111-4111-8111-111111111111";
const FREE = "22222222-2222-4222-8222-222222222222";
const HOUSE = "house-1";

type SourceRead = { data: { workspace_id: string } | null; error: { message: string } | null };

function setup(source: SourceRead, houseWorkspaceId = LOCKED) {
  const db = {
    rpc: vi.fn(),
    from: (table: string) => {
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => source,
              eq: () => ({
                maybeSingle: async () => ({ data: { id: HOUSE, workspace_id: houseWorkspaceId, manager_user_id: OWNER }, error: null }),
              }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: HOUSE }], error: null }) }) }) }),
        };
      }
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    },
  };
  mocks.serverClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: OWNER } } })) } });
  mocks.serviceClient.mockReturnValue(db);
  mocks.userIsManager.mockResolvedValue(true);
  mocks.businessAccess.mockResolvedValue({ kind: "normal" });
  mocks.loadWorkspaces.mockResolvedValue([]);
  mocks.standing.mockResolvedValue({ workspaceId: FREE, ownerUserId: OWNER, rights: { houses: true } });
  mocks.preview.mockResolvedValue({ loses: [], keeps: [], gains: [] });
  // The destination is free; the locked workspace is the one the house is moving OUT of.
  mocks.lockedIds.mockResolvedValue([LOCKED]);
  return db;
}

const move = () =>
  POST(new Request("http://localhost/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ action: "move-property", id: FREE, propertyId: HOUSE }),
    headers: { "content-type": "application/json" },
  }));

beforeEach(() => vi.clearAllMocks());

describe("moving a house out of a view-only workspace", () => {
  it("is refused when the source workspace is locked", async () => {
    setup({ data: { workspace_id: LOCKED }, error: null });
    expect((await move()).status).toBe(403);
  });

  it("is refused when the source workspace cannot be READ — the lock fails closed", async () => {
    setup({ data: null, error: { message: "boom" } });
    const response = await move();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: expect.any(String) });
  });

  it("still allows a move out of an unlocked workspace", async () => {
    setup({ data: { workspace_id: FREE }, error: null }, FREE);
    const response = await move();
    expect(await response.json()).toMatchObject({ ok: true });
    expect(response.status).toBe(200);
  });
});
