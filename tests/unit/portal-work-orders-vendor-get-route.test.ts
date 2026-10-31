/**
 * `GET /api/portal-work-orders` through the real route, for the vendor portal.
 *
 * A job the vendor HOLDS is named by `vendor_user_id`. The release additionally resolves a
 * manager-scoped directory id so the vendor's Auth subject never leaves the server in `vendorId` —
 * but it then dropped the whole record when that id could not be resolved, which is routine: a
 * manager removing the vendor from their roster mid-job, or a duplicate roster row under the same
 * manager. Those vendors lost their own assigned AND completed jobs, including the completed ones
 * they invoice from, with no error.
 *
 * The row is the vendor's either way. Only the identity that could not be verified is withheld.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ getUser: vi.fn(), portalContext: vi.fn() }));

type Row = Record<string, unknown>;

const VENDOR = "vendor-auth-id";
const MANAGER = "manager-1";

let DIRECTORY: Row[];
let ASSIGNED: Row[];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: hoisted.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: () => hoisted.portalContext(),
}));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => false }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/resident-role-access", () => ({ resolveResidentScopedActorRole: async () => "denied" }));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: async () => new Set<string>(),
    resolveManagerWorkspaceRowScope: async () => ({ propertyIds: null, untaggedOwnedVisible: true }),
  };
});
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/auth/resident-subject-evidence.server", () => ({
  residentSubjectHasHouse: async () => false,
  boundResidentSubjectForManagerHouse: async () => null,
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/work-order-vendor-messages.server", () => ({
  emitVendorAssigned: async () => undefined,
  offerNewServiceToPreferredVendor: async () => undefined,
}));
vi.mock("@/lib/work-order-auto-time.server", () => ({
  autoTimeNewWorkOrder: async (_d: unknown, _m: unknown, row: unknown) => ({ row, outcome: { kind: "none" } }),
  notifyVisitAutoBooked: async () => undefined,
  willDispatchRun: async () => false,
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));
vi.mock("@/lib/resident-work-order-lifecycle.server", () => ({ deleteWorkOrderRecord: async () => ({ error: null }) }));
vi.mock("@/lib/service-automation-settings.server", () => ({ loadServiceAutomationSettings: async () => null }));
vi.mock("@/lib/one-number/ops-alerts.server", () => ({ alertPhonesOf: async () => undefined }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: async () => [],
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
  resolveTestWorkspaceClassification: async () => ({ kind: "normal" }),
}));

import { GET } from "@/app/api/portal-work-orders/route";

/** Only the tables the vendor read touches; everything else answers empty. */
function makeDb() {
  const table = (name: string) => {
    const filters: Row = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => ((filters[column] = value), builder),
      in: () => builder,
      not: () => builder,
      is: () => builder,
      order: () => builder,
      limit: async () => ({ data: rowsFor(name), error: null }),
      maybeSingle: async () => ({ data: name === "profiles" ? { email: "v@test.local", role: "vendor" } : null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rowsFor(name), error: null }).then(resolve),
    };
    const rowsFor = (t: string): Row[] => {
      if (t === "manager_vendor_records") return DIRECTORY;
      if (t === "portal_work_order_records") return ASSIGNED;
      return [];
    };
    return builder;
  };
  return { from: (name: string) => table(name) };
}

const job = (): Row => ({
  id: "wo-1",
  manager_user_id: MANAGER,
  updated_at: "2026-10-30T00:00:00.000Z",
  row_data: {
    id: "wo-1",
    title: "Leaking tap",
    bucket: "scheduled",
    propertyAddress: "1 Main St, Seattle, WA",
    propertyName: "5257 Brooklyn",
    reference: "WO-1",
    vendorId: VENDOR,
    vendorAssignedAt: "2026-10-29T00:00:00.000Z",
    assignee: { type: "vendor", id: VENDOR, name: "Vera Vendor" },
    managerUserId: MANAGER,
    residentUserId: "resident-1",
    residentEmail: "resident@example.test",
  },
});

const read = async () => {
  const res = await GET(new Request("http://localhost/api/portal-work-orders"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: Row[] }).rows;
};

beforeEach(() => {
  vi.clearAllMocks();
  DIRECTORY = [];
  ASSIGNED = [job()];
  hoisted.getUser.mockResolvedValue({ data: { user: { id: VENDOR, email: "v@test.local" } } });
  hoisted.portalContext.mockResolvedValue({ user: { id: VENDOR }, profile: null, roles: ["vendor"], effectiveRole: "vendor" });
});

describe("a hired vendor's own job survives an unresolvable directory id", () => {
  it("returns the job with its site when the vendor was removed from the manager's roster", async () => {
    DIRECTORY = [];

    const rows = await read();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "wo-1", title: "Leaking tap", propertyAddress: "1 Main St, Seattle, WA" });
  });

  it("returns the job when two duplicate directory rows make the id ambiguous", async () => {
    DIRECTORY = [
      { id: "directory-a", manager_user_id: MANAGER },
      { id: "directory-dup", manager_user_id: MANAGER },
    ];

    const rows = await read();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "wo-1", propertyAddress: "1 Main St, Seattle, WA" });
  });

  it("withholds the unverified vendorId and assignee id, and every Auth subject", async () => {
    DIRECTORY = [];

    const rows = await read();

    const serialized = JSON.stringify(rows[0]);
    expect(rows[0]).not.toHaveProperty("vendorId");
    expect(rows[0]).not.toHaveProperty("managerUserId");
    expect(rows[0]).not.toHaveProperty("residentUserId");
    // A HIRED vendor still sees the resident's contact — that is the site they were hired for.
    expect(rows[0]).toMatchObject({ residentEmail: "resident@example.test" });
    expect(serialized).not.toContain(VENDOR);
    expect(serialized).not.toContain(MANAGER);
    expect(serialized).not.toContain("resident-1");
    expect((rows[0] as { assignee?: { id?: string; name?: string } }).assignee).toEqual({
      type: "vendor",
      id: "",
      name: "Vera Vendor",
    });
  });

  it("carries the verified directory id when the roster resolves it", async () => {
    DIRECTORY = [{ id: "directory-a", manager_user_id: MANAGER }];

    const rows = await read();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendorId: "directory-a", assignee: { type: "vendor", id: "directory-a" } });
    expect(JSON.stringify(rows[0])).not.toContain(VENDOR);
  });
});
