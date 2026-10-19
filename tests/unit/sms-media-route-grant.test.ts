// MMS media: team membership is not a grant. The viewer needs Communication on a house of the file's workspace.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const s = vi.hoisted(() => ({
  user: { id: "mate" } as { id: string } | null,
  file: { workspace_id: "ws-1" } as { workspace_id: string } | null,
  scope: null as unknown,
  workspaces: [] as Array<{ id: string; ownerUserId: string; propertyIds: string[] }>,
}));
const OWNER = "11111111-1111-4111-8111-111111111111";
const PATH = `manager/${OWNER}/SM1/0.jpg`;

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: s.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: s.file, error: null }) }) }) }) }),
}));
vi.mock("@/lib/sms-media.server", () => ({ createSmsMediaSignedUrl: async () => "https://signed.example/x" }));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({ resolveCommunicationScope: async () => s.scope }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: async () => s.workspaces }));

import { GET } from "@/app/api/sms-media/route";

const scope = (over: Record<string, unknown> = {}) => ({
  ownerIds: ["mate", OWNER],
  grantedHousesByOwner: new Map([[OWNER, new Set(["h1"])]]),
  teamWorkspacesByOwner: new Map([[OWNER, new Map([["ws-1", { canPost: true }]])]]),
  ...over,
});
const get = () => GET(new Request(`http://x/api/sms-media?path=${encodeURIComponent(PATH)}`));

beforeEach(() => {
  s.user = { id: "mate" };
  s.file = { workspace_id: "ws-1" };
  s.scope = scope();
  s.workspaces = [{ id: "ws-1", ownerUserId: OWNER, propertyIds: ["h1", "h2"] }];
});

describe("GET /api/sms-media for a teammate", () => {
  it("opens for a team member with Communication on a house of the file's workspace", async () => {
    expect((await get()).status).toBe(302);
  });

  it("is 404 for a team member whose grant is another module (no inbox owner scope)", async () => {
    s.scope = scope({ ownerIds: ["mate"], grantedHousesByOwner: new Map() });
    expect((await get()).status).toBe(404);
  });

  it("is 404 when the granted house is not in the file's workspace", async () => {
    s.workspaces = [{ id: "ws-1", ownerUserId: OWNER, propertyIds: ["h2"] }];
    expect((await get()).status).toBe(404);
  });

  it("is 404 for a non-member of the workspace, and for an unindexed file", async () => {
    s.scope = scope({ teamWorkspacesByOwner: new Map() });
    expect((await get()).status).toBe(404);
    s.scope = scope();
    s.file = null;
    expect((await get()).status).toBe(404);
  });
});
