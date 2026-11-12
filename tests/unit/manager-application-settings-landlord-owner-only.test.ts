/**
 * The landlord name is the workspace OWNER's: it is written to the owner's row and printed on every lease.
 * A co-manager holding `applications` edit on one house passes the settings-scope gate (it resolves to the
 * owner's id) but must not rewrite it. The owner, and PropLane Service staff on an Admin / Full seat, may.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const CO_MANAGER = "co-1";
const STAFF = "staff-1";
const WORKSPACE = "ws-1";

const requireManagerRouteUser = vi.fn();
const saveManagerLandlordProfile = vi.fn();
const serviceStaffSettingsAccess = vi.fn();

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: () => requireManagerRouteUser(),
}));
vi.mock("@/lib/scope/settings-scope", () => ({
  resolveSettingsScopeParams: (_url: string, body?: Record<string, unknown> | null) => ({
    ...(typeof body?.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
  }),
  // Every caller in this file clears the module gate and resolves to the owner's account.
  assertSettingsScopeOwned: async (_db: unknown, _caller: string, scope: { workspaceId?: string }) => ({
    ok: true,
    ownerUserId: OWNER,
    workspaceId: scope.workspaceId ?? null,
    propertyId: null,
  }),
  serviceStaffSettingsAccess: (...a: unknown[]) => serviceStaffSettingsAccess(...a),
  trackSettingsScopeChanged: async () => undefined,
  writeRungFromSource: () => "account",
}));
vi.mock("@/lib/manager-landlord-profile", () => ({
  resolveWorkspaceLandlordLegalName: async () => ({
    landlordLegalName: "Doe Holdings LLC",
    source: "setting",
    setting: "Doe Holdings LLC",
    ownerFullName: "Doe",
  }),
  saveManagerLandlordProfile: (...a: unknown[]) => saveManagerLandlordProfile(...a),
  validateLandlordLegalName: (raw: unknown) => ({ ok: true, landlordLegalName: String(raw ?? "") }),
}));

const route = await import("@/app/api/portal/manager-application-settings/route");

function patch(body: unknown): Request {
  return new Request("http://localhost/api/portal/manager-application-settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  saveManagerLandlordProfile.mockResolvedValue({});
  serviceStaffSettingsAccess.mockResolvedValue({ kind: "none" });
});

describe("PATCH landlordLegalName", () => {
  it("refuses a co-manager and writes nothing", async () => {
    requireManagerRouteUser.mockResolvedValue({ db: {}, userId: CO_MANAGER });
    const res = await route.PATCH(patch({ workspaceId: WORKSPACE, landlordLegalName: "Takeover LLC" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only the workspace owner can change the landlord name.");
    expect(saveManagerLandlordProfile).not.toHaveBeenCalled();
  });

  it("refuses a read-only or non-full staff seat", async () => {
    requireManagerRouteUser.mockResolvedValue({ db: {}, userId: STAFF });
    serviceStaffSettingsAccess.mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: false });
    const res = await route.PATCH(patch({ workspaceId: WORKSPACE, landlordLegalName: "Takeover LLC" }));
    expect(res.status).toBe(403);
    expect(saveManagerLandlordProfile).not.toHaveBeenCalled();
  });

  it("lets the owner change it", async () => {
    requireManagerRouteUser.mockResolvedValue({ db: {}, userId: OWNER });
    const res = await route.PATCH(patch({ landlordLegalName: "Doe Holdings LLC" }));
    expect(res.status).toBe(200);
    expect(saveManagerLandlordProfile).toHaveBeenCalledWith(expect.anything(), OWNER, {
      landlordLegalName: "Doe Holdings LLC",
    });
    expect(serviceStaffSettingsAccess).not.toHaveBeenCalled();
  });

  it("lets PropLane Service staff on an Admin / Full seat change it", async () => {
    requireManagerRouteUser.mockResolvedValue({ db: {}, userId: STAFF });
    serviceStaffSettingsAccess.mockResolvedValue({ kind: "ok", ownerUserId: OWNER, fullGrant: true });
    const res = await route.PATCH(patch({ workspaceId: WORKSPACE, landlordLegalName: "Doe Holdings LLC" }));
    expect(res.status).toBe(200);
    expect(saveManagerLandlordProfile).toHaveBeenCalledWith(expect.anything(), OWNER, {
      landlordLegalName: "Doe Holdings LLC",
    });
  });
});
