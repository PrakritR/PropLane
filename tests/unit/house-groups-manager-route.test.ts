// The manager's House chat route: workspace from the session (never the body), the house re-checked against it,
// settings are the owner's, and it is simply absent (404) while the line is per-workspace.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, HOUSE, OWNER, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

const ctxState = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: vi.fn(async () => ctxState.ctx),
  propertyInWorkspace: vi.fn(async (_db: unknown, workspace: { propertyIds: string[] }, id: string) => (workspace.propertyIds.includes(id) ? { id, live: true } : null)),
}));
const sync = vi.hoisted(() => vi.fn(async () => ({ propertyId: "prop-1", outcome: "created", members: 2, overflow: 0 })));
vi.mock("@/lib/house-groups/manager.server", () => ({ syncHouseGroup: sync }));
vi.mock("@/lib/house-groups/residents.server", () => ({
  loadHouseResidentCandidates: vi.fn(async () => []),
}));
const posts = vi.hoisted(() => ({ postToHouseGroup: vi.fn(async () => ({ ok: true, messageSid: "IM1" })) }));
vi.mock("@/lib/house-groups/post.server", () => posts);

import { GET, POST } from "@/app/api/portal/house-groups/route";

const groupRows = () => ({
  house_group_conversations: [{ id: "g1", workspace_id: WS, property_id: HOUSE, conversation_sid: "CH1", status: "active", member_hash: "h" }],
  house_group_members: [
    { id: "m1", group_id: "g1", phone_key: "2065550101", phone_e164: "+12065550101", first_name: "Maya", room_label: "Room 1", left_at: null },
  ],
});

function setCtx(db: unknown, over: { userId?: string } = {}) {
  ctxState.ctx = { db, userId: over.userId ?? OWNER, workspace: { id: WS, ownerUserId: OWNER, propertyIds: [HOUSE] } };
}
const get = (propertyId = HOUSE) => GET(new Request(`https://x.test/api/portal/house-groups?propertyId=${propertyId}`));
const post = (body: Record<string, unknown>) =>
  POST(new Request("https://x.test/api/portal/house-groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  ctxState.ctx = null;
  sync.mockClear();
  posts.postToHouseGroup.mockClear();
});

describe("GET /api/portal/house-groups", () => {
  it("is 401 signed out and 404 while the line is per-workspace", async () => {
    expect((await get()).status).toBe(401);
    setCtx(fakeDb({ sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] }).db);
    expect((await get()).status).toBe(404);
  });

  it("returns members as first name and room only", async () => {
    setCtx(fakeDb(groupRows()).db);
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ enabled: true, canManage: true, group: { members: [{ firstName: "Maya", roomLabel: "Room 1" }] } });
    expect(JSON.stringify(json)).not.toContain("2065550101");
  });

  it("404s a house outside the workspace", async () => {
    setCtx(fakeDb(groupRows()).db);
    expect((await get("someone-elses-house")).status).toBe(404);
  });

  it("reports no group while house chat is off", async () => {
    setCtx(fakeDb({ ...groupRows(), house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] }).db);
    const json = await (await get()).json();
    expect(json).toMatchObject({ enabled: false, group: null });
  });
});

describe("POST /api/portal/house-groups", () => {
  it("lets only the workspace owner change the switch and the daily cap", async () => {
    const world = fakeDb(groupRows());
    setCtx(world.db, { userId: "a-teammate" });
    expect((await post({ action: "settings", enabled: false })).status).toBe(403);
    setCtx(world.db);
    const res = await post({ action: "settings", enabled: true, maxPostsPerDay: 6 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, enabled: true, maxPostsPerDay: 6 });
    expect(world.rows.house_group_settings[0]).toMatchObject({ workspace_id: WS, max_posts_per_day: 6, updated_by: OWNER });
  });

  it("syncs only a house of this workspace", async () => {
    setCtx(fakeDb(groupRows()).db);
    expect((await post({ action: "sync", propertyId: "someone-elses-house" })).status).toBe(404);
    expect(sync).not.toHaveBeenCalled();
    const ok = await post({ action: "sync", propertyId: HOUSE });
    expect(ok.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, propertyId: HOUSE, reason: "manager" });
  });

  it("announces to this house with the workspace from the session, ignoring a workspace in the body", async () => {
    setCtx(fakeDb(groupRows()).db);
    const res = await post({ action: "announce", propertyId: HOUSE, text: "Water off Tuesday 9 to 12.", requestId: "r1", workspaceId: "other-ws" });
    expect(res.status).toBe(200);
    expect(posts.postToHouseGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: WS, propertyId: HOUSE, kind: "announcement", idempotencyKey: "announce:r1:prop-1" }),
      expect.anything(),
    );
    expect((await post({ action: "announce", propertyId: HOUSE, text: "   " })).status).toBe(400);
    expect((await post({ action: "announce", propertyId: HOUSE, text: "x".repeat(400) })).status).toBe(400);
  });

  it("reports why an announcement did not go out", async () => {
    setCtx(fakeDb(groupRows()).db);
    posts.postToHouseGroup.mockResolvedValueOnce({ ok: false, reason: "quiet_hours" } as never);
    const res = await post({ action: "announce", propertyId: HOUSE, text: "Hi", requestId: "r2" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("between 10 pm and 8 am");
  });

  it("rejects an unknown action", async () => {
    setCtx(fakeDb(groupRows()).db);
    expect((await post({ action: "delete-everything", propertyId: HOUSE })).status).toBe(400);
  });
});
