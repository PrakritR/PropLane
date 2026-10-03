/**
 * comms-safety-0929 Part C at the route: `POST /api/portal-work-orders`.
 *  - Assigning a vendor in the Services panel is a DIFF against the stored row:
 *    a new vendor sends "You were assigned", the same vendor again (a retry or
 *    a re-sync of the whole list) sends nothing, a manager keeping the job
 *    themselves sends nothing, and a resident can never trigger it.
 *  - A newly filed RESIDENT service is offered to the preferred vendor (D3),
 *    but not on an edit, and not when vendor dispatch will propose the vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const { getUser, resolveResidentScopedActorRole, resolveManagerWorkspaceRowScope, emitVendorAssigned, offerNewService, willDispatchRun } =
  vi.hoisted(() => ({
    getUser: vi.fn(),
    resolveResidentScopedActorRole: vi.fn(),
    resolveManagerWorkspaceRowScope: vi.fn(),
    emitVendorAssigned: vi.fn(),
    offerNewService: vi.fn(),
    willDispatchRun: vi.fn(),
  }));

let STORED_ROW: Record<string, unknown> | null;

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>()),
  fetchRowsForManagerWithLinked: async () => [],
  linkedPropertyIdsForModule: async () => new Set<string>(),
  resolveManagerWorkspaceRowScope: (...a: unknown[]) => resolveManagerWorkspaceRowScope(...(a as [])),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({
  resolveResidentScopedActorRole: (...a: unknown[]) => resolveResidentScopedActorRole(...(a as [])),
}));
vi.mock("@/lib/resident-manager-scope", () => ({
  resolveResidentFilingScope: async () => ({ managerUserId: "mgr-1", propertyId: "prop-a" }),
}));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => [] }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));
vi.mock("@/lib/resident-work-order-lifecycle.server", () => ({ deleteWorkOrderRecord: async () => ({ error: null }) }));
vi.mock("@/lib/work-order-auto-time.server", () => ({
  autoTimeNewWorkOrder: async (_d: unknown, _m: unknown, row: unknown) => ({ row, outcome: { kind: "none" } }),
  notifyVisitAutoBooked: async () => undefined,
  willDispatchRun: (...a: unknown[]) => willDispatchRun(...(a as [])),
}));
vi.mock("@/lib/service-automation-settings.server", () => ({ loadServiceAutomationSettings: async () => null }));
vi.mock("@/lib/work-order-vendor-messages.server", () => ({
  emitVendorAssigned: (...a: unknown[]) => emitVendorAssigned(...a),
  offerNewServiceToPreferredVendor: (...a: unknown[]) => offerNewService(...a),
}));

import { POST as workOrdersPost } from "@/app/api/portal-work-orders/route";

function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        limit: async () => ({ data: [], error: null }),
        upsert: vi.fn(() => Promise.resolve({ error: null })),
      };
      if (table === "profiles") {
        builder.maybeSingle = async () => ({ data: { email: "caller@test.proplane.local", role: "manager" }, error: null });
      } else if (table === "manager_vendor_records") {
        builder.maybeSingle = async () => ({
          data: { manager_user_id: "mgr-1", vendor_user_id: "vendor-user-1", row_data: { name: "North Plumbing" } },
          error: null,
        });
      } else if (table === "portal_work_order_records") {
        builder.maybeSingle = async () => ({ data: STORED_ROW, error: null });
      } else {
        builder.maybeSingle = async () => ({ data: null, error: null });
      }
      return builder;
    },
  };
}

const post = (row: Record<string, unknown>) =>
  workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { row } }));
const replace = (rows: Record<string, unknown>[]) =>
  workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { action: "replace", rows } }));

const stored = (rowData: Record<string, unknown>) => ({
  manager_user_id: "mgr-1",
  resident_email: null,
  dispatch: undefined,
  row_data: { id: "wo-1", propertyId: "prop-a", title: "Leaking sink", ...rowData },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  STORED_ROW = null;
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "caller@test.proplane.local" } } });
  resolveResidentScopedActorRole.mockResolvedValue("manager");
  resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: null, untaggedOwnedVisible: true });
  emitVendorAssigned.mockResolvedValue({ sent: true, duplicate: false });
  offerNewService.mockResolvedValue({ offered: true, vendorDirectoryId: "vd-1" });
  willDispatchRun.mockResolvedValue(false);
});

describe("assigning a vendor in the Services panel", () => {
  const assign = { id: "wo-1", propertyId: "prop-a", title: "Leaking sink", vendorId: "vd-1", vendorName: "North Plumbing", vendorAssignedAt: "2026-09-29T10:00:00.000Z" };

  it("a vendor newly on the service is messaged once, keyed to the assignment time", async () => {
    STORED_ROW = stored({});
    const res = await post(assign);
    expect(res.status).toBe(200);
    expect(emitVendorAssigned).toHaveBeenCalledTimes(1);
    expect(emitVendorAssigned.mock.calls[0]![1]).toMatchObject({
      workOrderId: "wo-1",
      managerUserId: "mgr-1",
      vendorDirectoryId: "vd-1",
      assignedAt: "2026-09-29T10:00:00.000Z",
    });
  });

  it("a created service that already names a vendor messages them too", async () => {
    STORED_ROW = null;
    await post(assign);
    expect(emitVendorAssigned).toHaveBeenCalledTimes(1);
  });

  it("the same vendor again (retry / re-sync) sends nothing new", async () => {
    STORED_ROW = stored({ vendorId: "vd-1", vendorAssignedAt: "2026-09-29T10:00:00.000Z" });
    await post(assign);
    await replace([assign, { ...assign, id: "wo-1" }]);
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("reassigning to a different vendor does message the new one", async () => {
    STORED_ROW = stored({ vendorId: "vd-1", vendorAssignedAt: "2026-09-29T10:00:00.000Z" });
    await post({ ...assign, vendorId: "vd-2", vendorAssignedAt: "2026-09-30T09:00:00.000Z" });
    expect(emitVendorAssigned).toHaveBeenCalledTimes(1);
    expect(emitVendorAssigned.mock.calls[0]![1]).toMatchObject({ vendorDirectoryId: "vd-2", assignedAt: "2026-09-30T09:00:00.000Z" });
  });

  it("a manager keeping the job themselves messages no vendor", async () => {
    STORED_ROW = stored({});
    await post({ ...assign, selfAssigned: true });
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("an edit that leaves the vendor alone sends nothing", async () => {
    STORED_ROW = stored({ vendorId: "vd-1", vendorAssignedAt: "2026-09-29T10:00:00.000Z" });
    await post({ ...assign, title: "Leaking sink (updated)" });
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("a failed send never fails the save", async () => {
    STORED_ROW = stored({});
    emitVendorAssigned.mockRejectedValue(new Error("delivery down"));
    const res = await post(assign);
    expect(res.status).toBe(200);
  });
});

describe("a resident files a service", () => {
  beforeEach(() => {
    resolveResidentScopedActorRole.mockResolvedValue("resident");
    getUser.mockResolvedValue({ data: { user: { id: "res-1", email: "alex@resident.test" } } });
  });
  const filed = { id: "wo-9", propertyId: "prop-a", title: "Leaking sink", category: "plumbing", bucket: "open" };

  it("offers the new service to the preferred vendor, once, after the save", async () => {
    STORED_ROW = null;
    const res = await post(filed);
    expect(res.status).toBe(200);
    await flush();
    expect(offerNewService).toHaveBeenCalledTimes(1);
    expect(offerNewService.mock.calls[0]![1]).toEqual({ workOrderId: "wo-9" });
  });

  it("a resident edit of an existing service offers nothing", async () => {
    STORED_ROW = { manager_user_id: "mgr-1", resident_email: "alex@resident.test", dispatch: undefined, row_data: filed };
    await post({ ...filed, title: "Leaking sink!" });
    await flush();
    expect(offerNewService).not.toHaveBeenCalled();
  });

  it("when vendor dispatch will propose the vendor, no direct offer is made", async () => {
    willDispatchRun.mockResolvedValue(true);
    await post(filed);
    await flush();
    expect(offerNewService).not.toHaveBeenCalled();
  });

  it("a resident cannot trigger an 'assigned' message", async () => {
    STORED_ROW = null;
    await post({ ...filed, vendorId: "vd-1", vendorAssignedAt: "2026-09-29T10:00:00.000Z" });
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("a manager logging a service never triggers the preferred-vendor offer", async () => {
    resolveResidentScopedActorRole.mockResolvedValue("manager");
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "caller@test.proplane.local" } } });
    STORED_ROW = null;
    await post(filed);
    await flush();
    expect(offerNewService).not.toHaveBeenCalled();
  });
});
