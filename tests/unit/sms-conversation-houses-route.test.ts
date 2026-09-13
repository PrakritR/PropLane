import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn(), scope: vi.fn(), ownership: vi.fn(),
  tags: vi.fn(), access: vi.fn(), replace: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: mocks.auth,
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
  hasAdminRole: (ctx: { roles: string[] }) => ctx.roles.includes("admin") }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: mocks.fetch, resolveSmsScopeManagerIds: mocks.scope }));
vi.mock("@/lib/auth/co-manager-invite-scope", () => ({ findPropertyIdsNotOwnedByManager: mocks.ownership }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/sms/conversation-houses.server", () => ({ loadConversationHouseScope: mocks.tags, setConversationHousesManually: mocks.replace }));
vi.mock("@/lib/sms/conversation-house-access.server", async (original) => ({
  ...await original<typeof import("@/lib/sms/conversation-house-access.server")>(), loadAssignableConversationHouses: mocks.access,
}));
import { GET, PATCH } from "@/app/api/manager/sms-conversations/houses/route";
const key = "owner:prospect:+12065550100";
const url = "https://example.test/api/manager/sms-conversations/houses";
const access = () => ({ assignable: new Map([["a", { ownerUserId: "owner", label: "A" }]]),
  workspaceHouses: new Map([["a", { ownerUserId: "owner", label: "A" }], ["b", { ownerUserId: "owner", label: "B" }]]) });
const request = (body: unknown = { conversationKey: key, propertyIds: ["a"] }) => new Request(url, { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "viewer" }, roles: ["manager"] });
  mocks.fetch.mockResolvedValue({ residents: [{ conversationKey: key, memberKeys: [key, "member"], ownerManagerUserId: "owner",
    houses: [{ propertyId: "a", source: "residency" }] }] });
  mocks.scope.mockResolvedValue(["viewer", "owner"]);
  mocks.ownership.mockResolvedValue({ ok: true, unowned: [] });
  mocks.rpc.mockResolvedValue({ data: "revision", error: null });
  mocks.tags.mockResolvedValue([{ conversation_key: key, property_id: "a" }]);
  mocks.access.mockResolvedValue(access());
  mocks.replace.mockResolvedValue(true);
});
it("uses persisted tags and sends the checked revision and member snapshot to the atomic write", async () => {
  expect((await PATCH(request())).status).toBe(200);
  expect(mocks.tags).toHaveBeenCalledWith(expect.anything(), "owner", [key, "member"]);
  expect(mocks.replace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ managerUserId: "owner", taggedByUserId: "viewer",
    memberKeys: [key, "member"], expectedTags: [{ conversation_key: key, property_id: "a" }], accessRevision: "revision" }));
});
it("does not let a derived residency tag conceal unauthorized persisted tags", async () => {
  mocks.tags.mockResolvedValue([{ conversation_key: key, property_id: "b" }]);
  expect((await PATCH(request())).status).toBe(403);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("does not infer permission to claim an untagged thread from its residency display", async () => {
  mocks.tags.mockResolvedValue([]);
  expect((await PATCH(request())).status).toBe(403);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it.each(["tags", "access"] as const)("fails closed if %s cannot be read", async (lookup) => {
  mocks[lookup].mockRejectedValue(new Error("unavailable"));
  expect((await PATCH(request())).status).toBe(503);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("requires an available access revision before evaluating tags", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "missing function" } });
  expect((await PATCH(request())).status).toBe(503);
  expect(mocks.tags).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("rejects mixed authorized and unauthorized house ids as a whole", async () => {
  expect((await PATCH(request({ conversationKey: key, propertyIds: ["a", "b"] }))).status).toBe(403);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it.each([null, [], { conversationKey: key, propertyIds: [null] }, { conversationKey: key, propertyIds: ["a", " "] }])("rejects invalid payload without clearing tags: %j", async (body) => {
  expect((await PATCH(request(body))).status).toBe(400);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("rejects unowned ids even when a picker snapshot includes them", async () => {
  mocks.ownership.mockResolvedValue({ ok: true, unowned: ["a"] });
  expect((await PATCH(request())).status).toBe(403);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("rejects a revoked workspace edit grant", async () => {
  mocks.scope.mockResolvedValue(["viewer"]);
  expect((await PATCH(request())).status).toBe(403);
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("does not report stale/failed atomic replacement as success", async () => {
  mocks.replace.mockResolvedValue(false);
  expect((await PATCH(request())).status).toBe(503);
});
it("returns only assignable houses for the requested workspace", async () => {
  const permitted = access();
  permitted.assignable.set("personal", { ownerUserId: "viewer", label: "Personal" });
  mocks.access.mockResolvedValue(permitted);
  const response = await GET(new Request(`${url}?ownerId=owner`));
  expect(await response.json()).toEqual({ houses: [{ propertyId: "a", label: "A", ownerUserId: "owner" }] });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each([GET, PATCH])("rejects unauthenticated access before reading data", async (handler) => {
  mocks.auth.mockResolvedValue({ user: null, roles: [] });
  expect((await handler(request())).status).toBe(401);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});
it.each([GET, PATCH])("rejects the wrong portal role before reading data", async (handler) => {
  mocks.auth.mockResolvedValue({ user: { id: "viewer" }, roles: ["resident"] });
  expect((await handler(request())).status).toBe(403);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});
