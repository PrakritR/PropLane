import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { canReplaceConversationHouses, loadAssignableConversationHouses } from "@/lib/sms/conversation-house-access.server";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { loadConversationHouseScope } from "@/lib/sms/conversation-houses.server";

const houses = vi.hoisted(() => new Map<string, { ownerUserId: string; label: string; aliases: string[] }>());
vi.mock("@/lib/manager-sms-messages.server", () => ({ loadWorkspaceHouseLabels: vi.fn(async () => houses) }));
const workspace = new Map([["a", { ownerUserId: "owner" }], ["b", { ownerUserId: "owner" }], ["foreign", { ownerUserId: "other" }]]);
const partial = new Map([["a", { ownerUserId: "owner" }], ["foreign", { ownerUserId: "other" }]]);
const check = (currentIds: string[], nextIds: string[], assignable = partial, viewerId = "viewer") => canReplaceConversationHouses({
  viewerId, ownerId: "owner", currentIds, nextIds, assignable, workspaceHouses: workspace,
});

describe("conversation house edit authorization", () => {
  it("allows a partial co-manager to update only granted tagged houses", () => {
    expect(check(["a"], ["a"])).toBe(true);
    expect(check(["a"], ["b"])).toBe(false);
    expect(check(["a", "b"], ["a"])).toBe(false);
    expect(check(["a"], ["foreign"])).toBe(false);
  });
  it("requires complete workspace access to claim or clear an untagged thread", () => {
    expect(check([], ["a"])).toBe(false);
    expect(check(["a"], [])).toBe(false);
    expect(check([], ["a"], workspace)).toBe(true);
    expect(check(["a"], [], workspace)).toBe(true);
  });
  it("lets owners remove stale tags, but never add a foreign or missing house", () => {
    expect(check(["deleted", "foreign"], ["a"], workspace, "owner")).toBe(true);
    expect(check(["deleted"], [], workspace, "owner")).toBe(true);
    expect(check(["a"], ["foreign"], workspace, "owner")).toBe(false);
    expect(check(["a"], ["missing"], workspace, "owner")).toBe(false);
  });
  it("does not turn an empty workspace into a co-manager grant", () => {
    expect(canReplaceConversationHouses({ viewerId: "viewer", ownerId: "owner", currentIds: [], nextIds: [],
      assignable: new Map(), workspaceHouses: new Map() })).toBe(false);
  });
  it("binds a transferred house's grant to its current owner", async () => {
    houses.clear();
    houses.set("transferred", { ownerUserId: "new-owner", label: "Transferred", aliases: [] });
    houses.set("granted", { ownerUserId: "new-owner", label: "Granted", aliases: [] });
    const db = createMemoryDb({ profiles: ["viewer", "old-owner", "new-owner"].map(id => ({ id, email: `${id}@example.test` })),
      account_link_invites: [
        { inviter_user_id: "old-owner", invitee_user_id: "viewer", status: "accepted", assigned_property_ids: ["transferred"], property_co_manager_permissions: { transferred: { inbox: true } } },
        { inviter_user_id: "new-owner", invitee_user_id: "viewer", status: "accepted", assigned_property_ids: ["granted"], property_co_manager_permissions: { granted: { inbox: true } } },
      ] });
    const access = await loadAssignableConversationHouses(db as never, "viewer");
    expect([...access.assignable.keys()]).toEqual(["granted"]);
  });
  it("excludes revoked, empty and read-only grants from edit scope", async () => {
    const db = createMemoryDb({ profiles: [{ id: "viewer", email: "viewer@example.test" }, { id: "owner", email: "owner@example.test" }],
      account_link_invites: [
        { inviter_user_id: "owner", invitee_user_id: "viewer", status: "cancelled", assigned_property_ids: ["revoked"], property_co_manager_permissions: { revoked: { inbox: true } } },
        { inviter_user_id: "owner", invitee_user_id: "viewer", status: "accepted", assigned_property_ids: ["read", "empty", "edit"], property_co_manager_permissions: { read: { inbox: { read: true } }, empty: {}, edit: { inbox: { read: true, edit: true } } } },
      ] });
    const scope = await linkedOwnerScopeForModule(db as never, "viewer", "inbox", "edit", { throwOnError: true });
    expect([...scope.propertyIdsByOwner.get("owner")!]).toEqual(["edit"]);
  });
  it("propagates lookup failures instead of treating access as known", async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error("offline") }) };
    await expect(linkedOwnerScopeForModule({ from: () => query } as never, "viewer", "inbox", "edit", { throwOnError: true })).rejects.toThrow("offline");
  });
});

describe("persisted tag authorization snapshot", () => {
  it("paginates exact owner/member scope rather than using a display fallback", async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ conversation_key: "key", property_id: `house-${i}` }));
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValueOnce({ data: first, error: null }).mockResolvedValueOnce({ data: [{ conversation_key: "member", property_id: "last" }], error: null }) };
    const result = await loadConversationHouseScope({ from: () => query } as never, "owner", ["key", "member"]);
    expect(result).toHaveLength(501);
    expect(query.eq).toHaveBeenCalledWith("manager_user_id", "owner");
    expect(query.in).toHaveBeenCalledWith("conversation_key", ["key", "member"]);
    expect(query.range.mock.calls).toEqual([[0, 499], [500, 999]]);
  });
  it("rejects a failed tag read instead of authorizing against an empty list", async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: null, error: new Error("tags unavailable") }) };
    await expect(loadConversationHouseScope({ from: () => query } as never, "owner", ["key"])).rejects.toThrow("tags unavailable");
  });
});
