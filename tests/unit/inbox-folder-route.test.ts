import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/portal-inbox-thread-scope", () => ({
  ADMIN_INBOX_SCOPE: "admin", MANAGER_INBOX_SCOPE: "manager", RESIDENT_INBOX_SCOPE: "resident",
  resolveInboxScopeUser: async () => ({ user: { id: "viewer", role: "manager" }, db: { from: mocks.from, rpc: mocks.rpc } }),
  applyPortalInboxThreadScope: (query: unknown) => query,
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ viewerAndLinkedOwnerIdsForModule: async () => [] }));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn() }));
import { POST } from "@/app/api/portal-inbox-threads/route";
beforeEach(() => {
  vi.clearAllMocks();
  const rows = ["email-new", "email-old"].map((id) => ({ id, owner_user_id: "viewer", scope: "manager", row_data: { folder: "inbox" } }));
  mocks.from.mockReturnValue({ select() { return this; }, in() { return this; }, then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(resolve); } });
  mocks.rpc.mockResolvedValue({ data: "ok", error: null });
});
it("passes every authorized collapsed source id to one folder transaction", async () => {
  const response = await POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST",
    body: JSON.stringify({ action: "changeFolder", scope: "manager", folderAction: "archive", ids: ["email-new", "email-old"] }) }));
  expect(response.status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("change_portal_inbox_thread_folders", {
    p_ids: ["email-new", "email-old"], p_scope: "manager", p_action: "archive",
  });
});
it("skips a collapsed source id the viewer cannot see instead of refusing the batch", async () => {
  // The stored merge still names `email-gone`; the list no longer returns it.
  const response = await POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST",
    body: JSON.stringify({ action: "changeFolder", scope: "manager", folderAction: "archive", ids: ["email-new", "email-old", "email-gone"] }) }));
  expect(response.status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("change_portal_inbox_thread_folders", {
    p_ids: ["email-new", "email-old"], p_scope: "manager", p_action: "archive",
  });
});
it("still refuses when none of the ids are the viewer's", async () => {
  mocks.from.mockReturnValue({ select() { return this; }, in() { return this; }, then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve); } });
  const refused = await POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST",
    body: JSON.stringify({ action: "changeFolder", scope: "manager", folderAction: "archive", ids: ["email-gone"] }) }));
  expect(refused.status).toBe(404);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
