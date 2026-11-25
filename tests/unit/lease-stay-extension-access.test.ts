import { beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ scope: vi.fn(), access: vi.fn(), permission: vi.fn(), workspace: vi.fn(), leasePermission: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: m.scope }));
vi.mock("@/lib/scope/settings-scope", () => ({ serviceStaffSettingsAccess: m.access }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanAccessLeaseRecord: m.leasePermission, managerHasCoManagerPermissionForProperty: m.permission }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: m.workspace }));
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancyEntriesForManager: vi.fn() }));
vi.mock("@/lib/lease-amendment.server", () => ({ propertyFromRecord: vi.fn() }));
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerChargeEntry: vi.fn() }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: m.emit }));
vi.mock("@/lib/resident-notice-channel.server", () => ({ residentNoticeChannel: async () => "portal" }));
import { authorizeStayExtension, completeStayExtension } from "@/lib/lease-stay-extension.server";
function db(owner = "owner", property = "house", error: unknown = null) { const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { id: "lease", manager_user_id: owner, property_id: property }, error }) }; return { from: () => chain } as never; }
beforeEach(() => { vi.resetAllMocks(); m.scope.mockResolvedValue({ workspaceId: "workspace", propertyIds: ["house"] }); m.access.mockResolvedValue({ kind: "ok", fullGrant: true, ownerUserId: "owner" }); });
describe("stay extension workspace authorization", () => {
  it("permits staff through the active managed workspace owner", async () => { expect((await authorizeStayExtension(db(), "staff", "lease")).manager_user_id).toBe("owner"); });
  it("does not let an admin's staff seat reach another house or owner", async () => { await expect(authorizeStayExtension(db("other"), "admin", "lease")).rejects.toThrow(/not found/); await expect(authorizeStayExtension(db("owner", "other-house"), "admin", "lease")).rejects.toThrow(/not found/); });
  it("requires leases edit for a limited staff seat", async () => { m.access.mockResolvedValue({ kind: "ok", fullGrant: false, ownerUserId: "owner" }); m.permission.mockResolvedValue(false); await expect(authorizeStayExtension(db(), "staff", "lease")).rejects.toThrow(); m.permission.mockResolvedValue(true); await expect(authorizeStayExtension(db(), "staff", "lease")).resolves.toBeTruthy(); expect(m.permission).toHaveBeenCalledWith(expect.anything(), "staff", "house", "leases", "edit", { strict: true }); });
  it("fails closed on role/scope/read failures", async () => { m.access.mockResolvedValue({ kind: "unavailable" }); await expect(authorizeStayExtension(db(), "staff", "lease")).rejects.toThrow(); await expect(authorizeStayExtension(db("owner", "house", {}), "staff", "lease")).rejects.toThrow(/read/); m.scope.mockRejectedValue(new Error("scope unavailable")); await expect(authorizeStayExtension(db(), "staff", "lease")).rejects.toThrow(/scope/); });
});

it("does not report a failed resident notice as successful when an extension is replayed", async () => {
  m.emit.mockResolvedValue({ duplicate: true, failed: 0, deferred: 0 });
  const event = { select: () => event, eq: vi.fn(() => event), single: async () => ({ data: { id: "event" }, error: null }) };
  const deliveries = { select: () => deliveries, eq: () => deliveries, then: (resolve: (value: unknown) => void) => resolve({ data: [{ status: "sms_failed" }], error: null }) };
  const client = { from: (table: string) => table === "action_events" ? event : deliveries } as never;
  const record = { id: "lease", manager_user_id: "owner", resident_email: "qa@example.invalid", property_id: "house", row_data: {} } as never;
  const extension = { id: "extension", lines: [], chargeIds: [], totalCents: 0, checkout: "2027-02-01" } as never;
  expect((await completeStayExtension(client, record, extension, { id: "staff" })).failed).toBe(1);
  expect(event.eq).toHaveBeenCalledWith("manager_user_id", "owner");
});
