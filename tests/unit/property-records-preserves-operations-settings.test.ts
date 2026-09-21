/**
 * A listing edit rebuilds `row_data` from the wizard's OWN fields and never
 * names Operations settings — `POST /api/property-records` must carry the
 * existing house's `operationsSettings` (reminder / automation overrides,
 * PLAN-0916-1040) forward when the request's `rowData` omits that key,
 * rather than silently wiping it the way a plain "write what the body says"
 * upsert would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let EXISTING_ROW: { manager_user_id: string; status?: string; row_data?: unknown; property_data?: unknown } | null =
  null;
let UPSERTS: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: null }),
}));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: EXISTING_ROW, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        UPSERTS.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

const OWNER = "mgr-owner-1";
const PROPERTY_ID = "mgr-house-1";
const OPERATIONS_SETTINGS = { reminderRules: { tour: { enabled: true } } };

function post(body: Record<string, unknown>) {
  return postPropertyRecord(jsonRequest("http://localhost/api/property-records", { method: "POST", body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
  EXISTING_ROW = {
    manager_user_id: OWNER,
    status: "live",
    row_data: { title: "House 1", operationsSettings: OPERATIONS_SETTINGS },
  };
});

describe("POST /api/property-records — preserves operationsSettings on a rowData write", () => {
  it("carries the existing operationsSettings forward when the body's rowData omits it", async () => {
    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      status: "live",
      rowData: { title: "House 1 (edited)" },
      propertyData: {},
    });
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    const rowData = UPSERTS[0]!.row_data as Record<string, unknown>;
    expect(rowData.operationsSettings).toEqual(OPERATIONS_SETTINGS);
    expect(rowData.title).toBe("House 1 (edited)");
  });

  it("security-review: a body-supplied operationsSettings is ignored — the stored value is kept, not the client's", async () => {
    // `operationsSettings` is the store behind house overrides for reminders /
    // automated messages / task automation, each gated by its own co-manager
    // module check in the dedicated PATCH routes. This route must never take
    // that key from a client body, even when the body names it explicitly —
    // otherwise a caller with only `properties` write access could smuggle an
    // override past those other routes' gates.
    const attackerSupplied = { reminderRules: { tour: { enabled: false } } };
    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      status: "live",
      rowData: { title: "House 1", operationsSettings: attackerSupplied },
      propertyData: {},
    });
    expect(res.status).toBe(200);
    const rowData = UPSERTS[0]!.row_data as Record<string, unknown>;
    expect(rowData.operationsSettings).toEqual(OPERATIONS_SETTINGS);
    expect(rowData.operationsSettings).not.toEqual(attackerSupplied);
  });

  it("a create (no existing row) writes exactly what the body sends, nothing to carry over", async () => {
    EXISTING_ROW = null;
    const res = await post({
      action: "upsert",
      id: "mgr-new-house",
      managerUserId: OWNER,
      status: "draft",
      rowData: { title: "Brand new" },
      propertyData: {},
    });
    expect(res.status).toBe(200);
    const rowData = UPSERTS[0]!.row_data as Record<string, unknown>;
    expect(rowData.operationsSettings).toBeUndefined();
  });

  it("omitting rowData entirely still keeps the existing row_data untouched (unrelated existing behavior)", async () => {
    const res = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: {} });
    expect(res.status).toBe(200);
    const rowData = UPSERTS[0]!.row_data as Record<string, unknown>;
    expect(rowData.operationsSettings).toEqual(OPERATIONS_SETTINGS);
    expect(rowData.title).toBe("House 1");
  });
});
