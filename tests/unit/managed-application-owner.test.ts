import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManagedApplicationOwner } from "@/lib/auth/managed-application-owner.server";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), access: vi.fn(), permission: vi.fn() }));
vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: mocks.scope }));
vi.mock("@/lib/scope/settings-scope", () => ({ serviceStaffSettingsAccess: mocks.access }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCoManagerPermissionForProperty: mocks.permission }));
function db(rows = [{ id: "house", manager_user_id: "owner", workspace_id: "workspace" }], error: unknown = null) {
  return { from: () => ({ select: () => ({ in: async () => ({ data: rows, error }) }) }) } as never;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ workspaceId: "workspace", propertyIds: ["house"] });
  mocks.access.mockResolvedValue({ kind: "ok", ownerUserId: "owner", fullGrant: true });
  mocks.permission.mockResolvedValue(false);
});
describe("managed application owner", () => {
  it("attributes new and legacy staff rows to the authenticated workspace owner", async () => {
    for (const storedOwner of [null, "staff", "owner"]) {
      expect(await resolveManagedApplicationOwner(db(), "staff", new Set(["house"]), storedOwner)).toEqual({ ok: true, owner: "owner" });
    }
  });
  it("leaves ordinary managers to the existing resolver", async () => {
    mocks.scope.mockResolvedValue(null);
    expect(await resolveManagedApplicationOwner(db(), "staff", new Set(["house"]), null)).toBeNull();
  });
  it("refuses another workspace, no placement, and another owner's stored record", async () => {
    for (const [ids, owner] of [[new Set(["other"]), null], [new Set<string>(), null], [new Set(["house"]), "stranger"]] as const) {
      expect((await resolveManagedApplicationOwner(db(), "staff", ids, owner))?.ok).toBe(false);
    }
  });
  it("does not treat a staff seat as a module edit grant", async () => {
    mocks.access.mockResolvedValue({ kind: "ok", ownerUserId: "owner", fullGrant: false });
    expect((await resolveManagedApplicationOwner(db(), "staff", new Set(["house"]), null))?.ok).toBe(false);
    mocks.permission.mockImplementation(async (_db, _actor, _id, module, level) => module === "residents" && level === "edit");
    expect((await resolveManagedApplicationOwner(db(), "staff", new Set(["house"]), null))?.owner).toBe("owner");
  });
  it("fails closed if ownership changed or a permission read failed", async () => {
    expect((await resolveManagedApplicationOwner(db([{ id: "house", manager_user_id: "other", workspace_id: "workspace" }]), "staff", new Set(["house"]), null))?.ok).toBe(false);
    expect((await resolveManagedApplicationOwner(db([], { message: "timeout" }), "staff", new Set(["house"]), null))?.ok).toBe(false);
    mocks.access.mockResolvedValue({ kind: "unavailable" });
    expect((await resolveManagedApplicationOwner(db(), "staff", new Set(["house"]), null))?.ok).toBe(false);
  });
});
