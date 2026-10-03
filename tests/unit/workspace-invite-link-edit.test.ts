import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: "owner" as string | null, list: vi.fn(), mint: vi.fn(), revoke: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user ? { id: mocks.user } : null } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ update: mocks.update }) }) }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://example.com" }));
vi.mock("@/lib/invite-links/invite-links.server", () => ({ listInviteLinksForWorkspace: mocks.list, listInviteLinksForActor: vi.fn(), mintInviteLink: mocks.mint, revokeInviteLink: mocks.revoke }));
import { PATCH } from "@/app/api/pro/invite-links/route";
const request = () => new Request("https://example.com/api/pro/invite-links", { method: "PATCH", body: JSON.stringify({ id: "old", workspaceId: "ws", teamRole: "leasing" }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = "owner";
  mocks.list.mockResolvedValue({ ok: true, links: [{ id: "old", assignedPropertyIds: ["house"], propertyPermissions: {}, teamRole: "viewer", houseScope: "all", workspacePermissions: {}, expiresAt: "2099-01-01T00:00:00.000Z", maxUses: 5, usedCount: 2, revokedAt: null }] });
  mocks.mint.mockResolvedValue({ ok: true, token: "new-token", link: { id: "new" } });
  mocks.revoke.mockResolvedValue({ ok: true }); mocks.update.mockReturnValue({ eq: mocks.eq }); mocks.eq.mockResolvedValue({ error: null });
});
it("rejects unauthenticated and unauthorized edits before minting", async () => {
  mocks.user = null; expect((await PATCH(request())).status).toBe(401); expect(mocks.list).not.toHaveBeenCalled();
  mocks.user = "stranger"; mocks.list.mockResolvedValue({ ok: false, status: 403, error: "Forbidden" });
  expect((await PATCH(request())).status).toBe(403); expect(mocks.mint).not.toHaveBeenCalled();
});
it("replaces the token, retains its remaining budget and revokes only that link", async () => {
  const response = await PATCH(request()); expect(response.status).toBe(200);
  expect(mocks.mint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: "owner", workspaceId: "ws", teamRole: "leasing", replaceActive: false }));
  expect(mocks.update).toHaveBeenCalledWith({ expires_at: "2099-01-01T00:00:00.000Z", max_uses: 3 });
  expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), { actorUserId: "owner", linkId: "old" });
  expect((await response.json()).url).toContain("new-token");
});
it("revokes the replacement when retiring the old URL fails", async () => {
  mocks.revoke.mockResolvedValueOnce({ ok: false, status: 409, error: "Changed" });
  expect((await PATCH(request())).status).toBe(409);
  expect(mocks.revoke).toHaveBeenLastCalledWith(expect.anything(), { actorUserId: "owner", linkId: "new" });
});
it("rejects exhausted links without creating a replacement", async () => {
  mocks.list.mockResolvedValue({ ok: true, links: [{ id: "old", maxUses: 1, usedCount: 1 }] });
  expect((await PATCH(request())).status).toBe(409); expect(mocks.mint).not.toHaveBeenCalled();
});
