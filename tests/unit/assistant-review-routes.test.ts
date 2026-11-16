/** Assistant quality routes: the actor (workspace + owner) is re-derived, never read from the body. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createFakeDb } from "../helpers/fake-table-db";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_MANAGED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_SELF_SERVE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const state = vi.hoisted(() => ({ db: null as unknown, manager: true as boolean, admin: true as boolean }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })) }));
vi.mock("@/lib/one-number/knowledge/route-auth.server", () => ({
  requireKnowledgeActor: async (level: string) =>
    state.manager
      ? { ok: true, actor: { userId: "mgr-1", db: state.db, workspaceId: WS_A, ownerUserId: "owner-1", isOwner: true, allowedPropertyIds: null, level } }
      : { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) },
}));
vi.mock("@/lib/one-number/admin-leads-guard.server", () => ({
  requirePlatformAdmin: async () => (state.admin ? { userId: "admin-1" } : { status: 403 }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  loadServiceInboxScope: async () => ({ serviceOwnerIds: [], clientOwnerIds: [], workspaceIds: [WS_MANAGED] }),
}));

const manager = await import("@/app/api/portal/assistant-review/route");
const admin = await import("@/app/api/admin/assistant-review/route");

const post = (handler: typeof manager.POST, body: unknown) =>
  handler(new Request("https://proplane.ai/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  state.manager = true;
  state.admin = true;
  state.db = createFakeDb({
    assistant_thread_reviews: [],
    property_knowledge_entries: [],
    sms_line_thread_state: [],
    portal_workspaces: [{ id: WS_MANAGED, owner_user_id: "svc-owner", is_service: true }],
  });
});

describe("manager route", () => {
  it("refuses a non-manager before anything is read or written", async () => {
    state.manager = false;
    expect((await post(manager.POST, { action: "pause", threadKey: "t1" })).status).toBe(403);
    expect((await manager.GET(new Request("https://proplane.ai/api/x?threadKey=t1"))).status).toBe(403);
    expect((state.db as { tables: Record<string, unknown[]> }).tables.assistant_thread_reviews).toHaveLength(0);
  });

  it("the workspace is the manager's ACTIVE one: a workspaceId in the body changes nothing", async () => {
    const res = await post(manager.POST, { action: "flag", threadKey: "t1", messageRef: "m1", reason: "wrong", workspaceId: WS_SELF_SERVE, ownerUserId: "someone-else" });
    expect(res.status).toBe(200);
    const row = (state.db as { tables: Record<string, Array<Record<string, unknown>>> }).tables.assistant_thread_reviews[0]!;
    expect(row).toMatchObject({ workspace_id: WS_A, owner_user_id: "owner-1", created_by_user_id: "mgr-1" });
  });

  it("flag -> state -> correct -> pause -> resume -> list, end to end", async () => {
    await post(manager.POST, { action: "flag", threadKey: "t1", messageRef: "m1", reason: "wrong" });
    await post(manager.POST, { action: "correct", threadKey: "t1", messageRef: "m1", question: "Parking?", correction: "Street only." });
    await post(manager.POST, { action: "takeover", threadKey: "t1" });
    const state1 = await (await manager.GET(new Request("https://proplane.ai/api/x?threadKey=t1"))).json();
    expect(state1).toMatchObject({ paused: true });
    expect(state1.corrections).toHaveLength(1);
    const list = await (await manager.GET(new Request("https://proplane.ai/api/x?view=list"))).json();
    expect(list.rows.map((r: { kind: string }) => r.kind)).toEqual(["pause"]);
    await post(manager.POST, { action: "resume", threadKey: "t1" });
    expect((await (await manager.GET(new Request("https://proplane.ai/api/x?threadKey=t1"))).json()).paused).toBe(false);
  });

  it("rejects an unusable thread key, an unknown action and a bad flag", async () => {
    expect((await post(manager.POST, { action: "pause", threadKey: "../../x" })).status).toBe(400);
    expect((await post(manager.POST, { action: "nuke", threadKey: "t1" })).status).toBe(400);
    expect((await post(manager.POST, { action: "flag", threadKey: "t1", messageRef: "m1", reason: "" })).status).toBe(400);
    expect((await manager.GET(new Request("https://proplane.ai/api/x"))).status).toBe(400);
  });
});

describe("admin route", () => {
  it("admin only", async () => {
    state.admin = false;
    expect((await post(admin.POST, { action: "pause", threadKey: "t1", workspaceId: WS_MANAGED })).status).toBe(403);
  });

  it("only a PropLane-managed workspace this surface already reads: a self-serve workspace is a 404, a non-id a 400", async () => {
    expect((await post(admin.POST, { action: "pause", threadKey: "t1", workspaceId: WS_SELF_SERVE })).status).toBe(404);
    expect((await post(admin.POST, { action: "pause", threadKey: "t1", workspaceId: "nope" })).status).toBe(400);
    expect((await post(admin.POST, { action: "pause", threadKey: "t1" })).status).toBe(400);
    expect((state.db as { tables: Record<string, unknown[]> }).tables.assistant_thread_reviews).toHaveLength(0);
  });

  it("acts on the managed workspace's own row, owned by the workspace owner read from the workspace (never the body)", async () => {
    const res = await post(admin.POST, { action: "pause", threadKey: "sms:2065550188", workspaceId: WS_MANAGED, ownerUserId: "evil", role: "resident" });
    expect(res.status).toBe(200);
    const tables = (state.db as { tables: Record<string, Array<Record<string, unknown>>> }).tables;
    expect(tables.assistant_thread_reviews[0]).toMatchObject({ workspace_id: WS_MANAGED, owner_user_id: "svc-owner", created_by_user_id: "admin-1", kind: "pause" });
    expect(tables.sms_line_thread_state[0]).toMatchObject({ phone_key: "2065550188", workspace_id: WS_MANAGED, ai_paused: true, role: "resident" });
    const got = await admin.GET(new Request(`https://proplane.ai/api/admin/assistant-review?workspaceId=${WS_MANAGED}&threadKey=sms:2065550188`));
    expect(await got.json()).toMatchObject({ paused: true });
  });
});
