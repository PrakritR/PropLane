import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";

const state = vi.hoisted(() => ({
  user: { id: "owner-a" } as { id: string } | null,
  workspace: { id: "ws-a", ownerUserId: "owner-a" },
  db: null as unknown,
  allowed: true,
  manager: true,
  grant: { ok: true, grant: { isOwner: false, grantedPropertyIds: new Set(["h1"]) } } as unknown,
  mayAct: true,
  askedLevels: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: async () => state.workspace }));
vi.mock("@/lib/manager-route-guard.server", () => ({ userHoldsManagerRole: async () => state.manager }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/one-number/communication-grant.server", () => ({
  resolveCommunicationGrant: async (_db: unknown, userId: string, ws: { ownerUserId: string }, level: string) => {
    state.askedLevels.push(level);
    return userId === ws.ownerUserId ? { ok: true, grant: { isOwner: true, grantedPropertyIds: null } } : state.grant;
  },
}));
vi.mock("@/lib/sms/sms-projection-inbox.server", () => ({
  viewerMayActOnSmsProjection: async (_db: unknown, _viewer: string, _id: string, level: string) => {
    state.askedLevels.push(`conv:${level}`);
    return state.mayAct;
  },
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: async () => (state.allowed ? { allowed: true } : { allowed: false, status: 403, message: "no", reason: "trial" }),
}));

import { GET, POST } from "@/app/api/portal/one-number/thread-state/route";

const CONV = "11111111-1111-4111-8111-111111111111";
const base = (over: Record<string, FakeRow[]> = {}, mode = "shared"): Record<string, FakeRow[]> => ({
  sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100", shared_pilot_workspace_ids: [] }],
  sms_projection_conversations: [{ id: CONV, owner_manager_user_id: "owner-a", counterparty_role: "resident", counterparty_phone: "+12065550142" }],
  ...over,
});
const use = (seed: Record<string, FakeRow[]>) => {
  const fake = fakeSharedLineDb(seed);
  state.db = fake.db;
  return fake;
};
const get = (id = CONV) => GET(new Request(`http://x/api/portal/one-number/thread-state?conversationId=${id}`));
const post = (body: unknown) =>
  POST(new Request("http://x/api/portal/one-number/thread-state", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.user = { id: "owner-a" };
  state.manager = true;
  state.grant = { ok: true, grant: { isOwner: false, grantedPropertyIds: new Set(["h1"]) } };
  state.mayAct = true;
  state.askedLevels = [];
  state.workspace = { id: "ws-a", ownerUserId: "owner-a" };
  state.allowed = true;
});

describe("thread-state route", () => {
  it("is 401 signed out, 400 for a bad id, and absent (404) on per-workspace numbers", async () => {
    use(base());
    state.user = null;
    expect((await get()).status).toBe(401);
    state.user = { id: "owner-a" };
    expect((await get("nope")).status).toBe(400);
    use(base({}, "per_workspace"));
    expect((await get()).status).toBe(404);
    expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(404);
  });

  it("pause then resume, scoped to the manager's workspace and the conversation's phone", async () => {
    const { rows } = use(base());
    expect(await (await get()).json()).toEqual({ paused: false });
    const paused = await post({ conversationId: CONV, action: "pause" });
    expect(await paused.json()).toEqual({ paused: true });
    expect(rows.sms_line_thread_state).toMatchObject([{ phone_key: "2065550142", workspace_id: "ws-a", ai_paused: true, paused_reason: "manager_takeover", role: "resident" }]);
    expect(await (await get()).json()).toEqual({ paused: true });
    expect(await (await post({ conversationId: CONV, action: "resume" })).json()).toEqual({ paused: false });
    expect(rows.sms_line_thread_state[0]).toMatchObject({ ai_paused: false, resumed_by: "owner-a" });
  });

  it("a conversation owned by another workspace owner is not found, even with a valid id", async () => {
    const { rows } = use(base({ sms_projection_conversations: [{ id: CONV, owner_manager_user_id: "owner-b", counterparty_role: "resident", counterparty_phone: "+12065550142" }] }));
    expect((await get()).status).toBe(404);
    expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(404);
    expect(rows.sms_line_thread_state ?? []).toEqual([]);
  });

  it("an owner's conversation stamped with ANOTHER of their workspaces is not this workspace's", async () => {
    use(base({ sms_projection_turns: [{ conversation_id: CONV, workspace_id: "ws-a2" }] }));
    expect((await get()).status).toBe(404);
    use(base({ sms_projection_turns: [{ conversation_id: CONV, workspace_id: "ws-a" }, { conversation_id: CONV, workspace_id: null }] }));
    expect((await get()).status).toBe(200);
    use(base({ sms_projection_turns: [{ conversation_id: CONV, workspace_id: "ws-a" }, { conversation_id: CONV, workspace_id: "ws-a2" }] }));
    expect((await get()).status).toBe(404);
  });

  it("refuses a manager's own side, a missing phone, an unknown action, and a plan that cannot use Communication", async () => {
    use(base({ sms_projection_conversations: [{ id: CONV, owner_manager_user_id: "owner-a", counterparty_role: "manager", counterparty_phone: "+12065550142" }] }));
    expect((await get()).status).toBe(404);
    use(base({ sms_projection_conversations: [{ id: CONV, owner_manager_user_id: "owner-a", counterparty_role: "resident", counterparty_phone: null }] }));
    expect((await get()).status).toBe(404);
    use(base());
    expect((await post({ conversationId: CONV, action: "delete" })).status).toBe(400);
    state.allowed = false;
    expect((await get()).status).toBe(403);
  });

  describe("a teammate is held to Communication on the conversation's house", () => {
    beforeEach(() => {
      state.user = { id: "mate" };
    });

    it("refuses a non-manager login before any workspace is read", async () => {
      use(base());
      state.manager = false;
      expect((await get()).status).toBe(403);
      expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(403);
    });

    it("refuses a teammate with no Communication grant (403 on read and write)", async () => {
      const { rows } = use(base());
      state.grant = { ok: false, status: 403, error: "nope" };
      expect((await get()).status).toBe(403);
      expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(403);
      expect(rows.sms_line_thread_state ?? []).toEqual([]);
    });

    it("refuses a conversation about a house the teammate does not hold", async () => {
      const { rows } = use(base());
      state.mayAct = false;
      expect((await get()).status).toBe(403);
      expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(403);
      expect(rows.sms_line_thread_state ?? []).toEqual([]);
    });

    it("reads at view level and changes only at edit level", async () => {
      const { rows } = use(base());
      expect((await get()).status).toBe(200);
      expect(state.askedLevels).toEqual(["read", "conv:read"]);
      state.askedLevels = [];
      expect((await post({ conversationId: CONV, action: "pause" })).status).toBe(200);
      expect(state.askedLevels).toEqual(["edit", "conv:edit"]);
      expect(rows.sms_line_thread_state).toMatchObject([{ ai_paused: true }]);
    });
  });
});
