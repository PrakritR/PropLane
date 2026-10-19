import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * POST /api/portal-inbox-threads: delete / deleteIds name no scope, so they used to skip the managed
 * view-only lock. A locked owner may delete nothing but her own Team chat / Assistant thread; a
 * forged workspace cookie does not lift the lock.
 */

const SCOPE = "axis_portal_inbox_manager_v1";
const CLIENT = "client-owner";
const W = "workspace-service";

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined) }),
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { id: CLIENT, email: "c@example.test", role: "manager" }, db: state.db }),
  applyPortalInboxThreadScope: (query: { in: (col: string, ids: string[]) => unknown }, user: { id: string }, extra: string[] = []) =>
    query.in("owner_user_id", [user.id, ...extra]),
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({ smsNoticeMembers: vi.fn(async (_db: unknown, t: { id: string }) => [{ id: t.id }]), storedSmsNoticeIdentity: () => false, updateSmsNoticeMailboxState: vi.fn() }));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "business" }) }));

import { POST } from "@/app/api/portal-inbox-threads/route";

const thread = (id: string) => ({
  id, scope: SCOPE, owner_user_id: CLIENT, participant_email: null, thread_type: null, updated_at: "2026-09-15T00:00:00.000Z",
  row_data: { id, folder: "inbox" },
});

function seed(purchases: Record<string, unknown>[] = []) {
  return createMemoryDb({
    profiles: [{ id: CLIENT, email: "c@example.test", role: "manager" }],
    profile_roles: [],
    platform_service_settings: [],
    manager_purchases: purchases,
    portal_workspaces: [{ id: W, name: "Managed", owner_user_id: CLIENT, is_default: true, is_service: true, created_at: "2026-01-01" }],
    account_link_invites: [],
    portal_inbox_thread_records: [thread("resident-thread-1"), thread("resident-thread-2")],
  });
}

const post = (body: Record<string, unknown>) =>
  POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.db = seed();
  state.cookie = undefined;
});

describe("POST /api/portal-inbox-threads — managed view-only lock covers delete", () => {
  it("delete and deleteIds of a non-team thread are 403 for a locked owner, with or without a forged cookie", async () => {
    for (const cookie of [undefined, "forged-workspace-id", W]) {
      state.cookie = cookie;
      const one = await post({ action: "delete", id: "resident-thread-1" });
      expect(one.status, `delete ${cookie}`).toBe(403);
      expect(((await one.json()) as { code: string }).code).toBe("read_only_managed");
      const many = await post({ action: "deleteIds", ids: ["resident-thread-1", "resident-thread-2"] });
      expect(many.status, `deleteIds ${cookie}`).toBe(403);
    }
    const rows = (state.db as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown[] }> } }).from("portal_inbox_thread_records").select("id");
    expect(((await rows).data ?? []).length).toBe(2);
  });

  it("a delete naming a scope other than the manager's is still locked", async () => {
    const res = await post({ action: "delete", id: "resident-thread-1", scope: "axis_portal_inbox_resident_v1" });
    expect(res.status).toBe(403);
  });

  it("once she holds a self-paid plan the same delete is not refused by the lock", async () => {
    state.db = seed([{ user_id: CLIENT, tier: "pro", stripe_subscription_id: "sub_1" }]);
    const res = await post({ action: "delete", id: "resident-thread-1" });
    expect(res.status).toBe(200);
  });
});
