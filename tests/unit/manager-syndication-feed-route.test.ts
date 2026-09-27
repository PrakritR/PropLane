// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

/**
 * W013: `GET /api/manager/syndication-feed` resolves the caller's ACTIVE
 * workspace (query param, else cookie, else default) and returns THAT
 * workspace's feed — never the account's only feed the way it worked before
 * workspaces existed. A co-manager acting in a shared workspace gets a feed
 * keyed to the workspace OWNER, never their own account.
 */

const MY_WS = { id: "ws-mine", name: "My workspace", ownerUserId: "mgr-1", owned: true, isDefault: true, propertyIds: [] as string[] };
const SECOND_WS = { id: "ws-second", name: "Second workspace", ownerUserId: "mgr-1", owned: true, isDefault: false, propertyIds: [] as string[] };
const SHARED_WS = { id: "ws-owner-2", name: "Owner two's workspace", ownerUserId: "mgr-2", owned: false, isDefault: true, propertyIds: [] as string[] };

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));
vi.mock("@/lib/app-url", () => ({
  resolveEmailLinkBaseUrl: () => "https://app.proplane.test",
}));
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveWorkspaceFromSettingsRequest: async (_db: unknown, _viewerUserId: string, request?: Request) => {
    const selected = request ? new URL(request.url).searchParams.get("workspaceId")?.trim() : "";
    if (selected === SECOND_WS.id) return SECOND_WS;
    if (selected === SHARED_WS.id) return SHARED_WS;
    return MY_WS;
  },
}));

const feedKeysByOwnerWorkspace = new Map<string, string>();
vi.mock("@/lib/listing-syndication/manager-syndication-feed.server", () => ({
  getOrCreateManagerSyndicationFeedKey: vi.fn(async (_db: unknown, ownerUserId: string, workspaceId: string) => {
    const cacheKey = `${ownerUserId}:${workspaceId}`;
    if (!feedKeysByOwnerWorkspace.has(cacheKey)) {
      feedKeysByOwnerWorkspace.set(cacheKey, `feed-${cacheKey}`);
    }
    return feedKeysByOwnerWorkspace.get(cacheKey)!;
  }),
  buildZillowFeedUrl: (origin: string, feedKey: string) => `${origin}/api/feeds/zillow/${feedKey}`,
}));

import { GET } from "@/app/api/manager/syndication-feed/route";

async function callFeed(url: string) {
  return GET(jsonRequest(url));
}

describe("GET /api/manager/syndication-feed (W013)", () => {
  beforeEach(() => {
    feedKeysByOwnerWorkspace.clear();
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  });

  it("401s an unauthenticated caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await callFeed("http://localhost/api/manager/syndication-feed");
    expect(res.status).toBe(401);
  });

  it("defaults to the caller's own default workspace's feed", async () => {
    const res = await callFeed("http://localhost/api/manager/syndication-feed");
    const body = await res.json();
    expect(body.workspaceId).toBe(MY_WS.id);
    expect(body.feedUrl).toContain(`feed-mgr-1:${MY_WS.id}`);
  });

  it("routes a second owned workspace to its OWN feed, never the default workspace's", async () => {
    const first = await (await callFeed("http://localhost/api/manager/syndication-feed")).json();
    const second = await (
      await callFeed(`http://localhost/api/manager/syndication-feed?workspaceId=${SECOND_WS.id}`)
    ).json();
    expect(second.workspaceId).toBe(SECOND_WS.id);
    expect(second.feedUrl).not.toBe(first.feedUrl);
  });

  it("a co-manager in a SHARED workspace gets a feed keyed to the workspace OWNER, not their own account", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "co-manager-1" } } }); // viewer ≠ owner
    const res = await callFeed(`http://localhost/api/manager/syndication-feed?workspaceId=${SHARED_WS.id}`);
    const body = await res.json();
    expect(body.workspaceId).toBe(SHARED_WS.id);
    // Keyed to SHARED_WS.ownerUserId ("mgr-2"), never the co-manager's own id.
    expect(body.feedUrl).toContain(`feed-${SHARED_WS.ownerUserId}:${SHARED_WS.id}`);
    expect(body.feedUrl).not.toContain("co-manager-1");
  });
});
