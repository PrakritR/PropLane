/**
 * `linkedServiceRequestId` marks a work order as the vendor job behind an add-on: it is hidden from the Services
 * lists and skips the manager's "new service" notice. It is manager-owned. A resident who sets it on their own
 * post would hide their service from the manager, so the server drops a client-sent value and only keeps one it
 * already stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  workOrderEvent: vi.fn(async () => undefined),
}));

let STORED_ROW: Record<string, unknown> | null;
let UPSERTS: Array<{ row_data: Record<string, unknown> }>;

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>()),
  fetchRowsForManagerWithLinked: async () => [],
  linkedPropertyIdsForModule: async () => new Set<string>(),
  resolveManagerWorkspaceRowScope: async () => ({ propertyIds: null, untaggedOwnedVisible: true }),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({ resolveResidentScopedActorRole: async () => "resident" }));
vi.mock("@/lib/resident-manager-scope", () => ({
  resolveResidentFilingScope: async () => ({ managerUserId: "mgr-1", propertyId: "prop-a" }),
}));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => ["mgr-1"] }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: mocks.workOrderEvent }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/work-order-vendor-messages.server", () => ({
  emitVendorAssigned: async () => undefined,
  offerNewServiceToPreferredVendor: async () => undefined,
}));
vi.mock("@/lib/work-order-auto-time.server", () => ({
  autoTimeNewWorkOrder: async (_db: unknown, _manager: string, row: unknown) => ({ row, outcome: { kind: "none" } }),
  notifyVisitAutoBooked: async () => undefined,
  willDispatchRun: async () => false,
}));
vi.mock("@/lib/service-automation-settings.server", () => ({ loadServiceAutomationSettings: async () => null }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));

import { POST as workOrdersPost } from "@/app/api/portal-work-orders/route";

function makeDb() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: async () => ({ data: { email: "res@example.com", role: "resident", full_name: "Mgr", sms_from_number: "" }, error: null }),
        };
      }
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: async () => ({ data: STORED_ROW, error: null }),
          upsert: vi.fn((row: { row_data: Record<string, unknown> }) => {
            UPSERTS.push(row);
            return Promise.resolve({ error: null });
          }),
        };
        return builder;
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
    },
  };
}

const postRow = (row: Record<string, unknown>) =>
  workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { row } }));

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  STORED_ROW = null;
  mocks.getUser.mockResolvedValue({ data: { user: { id: "res-1", email: "res@example.com" } } });
});

describe("a resident cannot mark their own work order as an add-on vendor job", () => {
  it("drops a client-sent link, so the service stays visible and the manager is still told about it", async () => {
    const res = await postRow({ id: "wo-res-1", title: "Leaking tap", propertyId: "prop-a", linkedServiceRequestId: "sr-victim", linkedWorkOrderId: "wo-x" });
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0]!.row_data).not.toHaveProperty("linkedServiceRequestId");
    expect(UPSERTS[0]!.row_data).not.toHaveProperty("linkedWorkOrderId");
    // The created-service notice to the manager's team was not skipped.
    expect(mocks.workOrderEvent).toHaveBeenCalled();
    expect(mocks.workOrderEvent.mock.calls[0]![1]).toMatchObject({ event: "created", workOrderId: "wo-res-1" });
  });

  it("keeps a link the server already stored on a row the resident edits, and never swaps it for another", async () => {
    STORED_ROW = {
      manager_user_id: "mgr-1",
      resident_email: "res@example.com",
      dispatch: null,
      row_data: { id: "wo-res-2", title: "Add-on job", linkedServiceRequestId: "sr-real" },
    };
    await postRow({ id: "wo-res-2", title: "Edited", propertyId: "prop-a", linkedServiceRequestId: "sr-other" });
    expect(UPSERTS[0]!.row_data.linkedServiceRequestId).toBe("sr-real");

    UPSERTS = [];
    await postRow({ id: "wo-res-2", title: "Edited", propertyId: "prop-a" });
    expect(UPSERTS[0]!.row_data.linkedServiceRequestId).toBe("sr-real");
  });
});
