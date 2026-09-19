/**
 * Background property mirrors intentionally send only one payload bucket.
 * The client must omit the other key, and this route must interpret that
 * omission as "keep the stored value". Explicit null remains the only way to
 * clear a bucket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
const MANAGER = "manager-payload-preservation";
const PROPERTY_ID = "mgr-payload-preservation";
const STORED_ROW_DATA = { marker: "owned-e2e-fixture", workspaceId: "workspace-1" };
const STORED_PROPERTY_DATA = { id: PROPERTY_ID, title: "Stored listing" };

let existing = {
  manager_user_id: MANAGER,
  status: "live",
  row_data: STORED_ROW_DATA as unknown,
  property_data: STORED_PROPERTY_DATA as unknown,
};
let upserts: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  existing = {
    manager_user_id: MANAGER,
    status: "live",
    row_data: STORED_ROW_DATA,
    property_data: STORED_PROPERTY_DATA,
  };
  upserts = [];
  getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
});

describe("POST /api/property-records omitted payload preservation", () => {
  it("keeps stored row_data when a live-listing mirror sends only propertyData", async () => {
    const nextPropertyData = { id: PROPERTY_ID, title: "Mirrored listing" };

    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "live",
      propertyData: nextPropertyData,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      manager_user_id: MANAGER,
      row_data: STORED_ROW_DATA,
      property_data: nextPropertyData,
    });
  });

  it("keeps stored property_data when a pending-row mirror sends only rowData", async () => {
    const nextRowData = { marker: "owned-e2e-fixture", workspaceId: "workspace-2" };

    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "pending",
      rowData: nextRowData,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      manager_user_id: MANAGER,
      row_data: nextRowData,
      property_data: STORED_PROPERTY_DATA,
    });
  });

  it("still clears both stored payloads when null is explicit", async () => {
    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "live",
      rowData: null,
      propertyData: null,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ row_data: null, property_data: null });
  });
});
