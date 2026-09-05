import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRows, linkedIds, ownedIds, fetchLeases, notifyManager, traceSystem } = vi.hoisted(() => ({
  fetchRows: vi.fn(),
  linkedIds: vi.fn().mockResolvedValue(new Set<string>()),
  ownedIds: vi.fn().mockResolvedValue(new Set(["property-1"])),
  fetchLeases: vi.fn(),
  notifyManager: vi.fn().mockResolvedValue({ delivered: true, suppressed: false }),
  traceSystem: vi.fn(async (opts: { run: () => Promise<unknown> }) => opts.run()),
}));

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  fetchRowsForManagerWithLinked: fetchRows,
  linkedPropertyIdsForModule: linkedIds,
}));

vi.mock("@/lib/auth/manager-application-access", () => ({
  managerOwnedPropertyIdSet: ownedIds,
}));

vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: fetchLeases,
}));

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/observability/langfuse", () => ({ traceSystemNotification: traceSystem }));

import {
  loadManagerAttentionSummary,
  deliverManagerAttentionDigest,
  managerAttentionDigestDue,
  managerAttentionDigestPeriodKey,
  renderManagerAttentionDigest,
} from "@/lib/manager-attention-digest.server";

describe("manager attention digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linkedIds.mockResolvedValue(new Set<string>());
    ownedIds.mockResolvedValue(new Set(["property-1"]));
    fetchLeases.mockResolvedValue([
      {
        id: "lease-1",
        row_data: { id: "lease-1", status: "Manager Signature Pending" },
        manager_user_id: "manager-1",
        property_id: "property-1",
      },
      {
        id: "lease-2",
        row_data: { id: "lease-2", status: "Fully Signed" },
        manager_user_id: "manager-1",
        property_id: "property-1",
      },
    ]);
    fetchRows.mockImplementation((_db: unknown, table: string) => {
      if (table === "manager_application_records") {
        return Promise.resolve([
          {
            id: "app-1",
            manager_user_id: "manager-1",
            property_id: "property-1",
            row_data: {
              id: "app-1",
              name: "Resident",
              property: "Oak House",
              stage: "Submitted",
              bucket: "pending",
              detail: "Submitted Sep 4",
              email: "resident@example.com",
            },
          },
        ]);
      }
      if (table === "portal_household_charge_records") {
        return Promise.resolve([
          {
            id: "charge-1",
            manager_user_id: "manager-1",
            property_id: "property-1",
            row_data: {
              id: "charge-1",
              kind: "rent",
              title: "September rent",
              amountLabel: "$1,200.00",
              balanceLabel: "$1,200.00",
              residentEmail: "resident@example.com",
              residentName: "Resident",
              propertyId: "property-1",
              propertyLabel: "Oak House",
              managerUserId: "manager-1",
              status: "pending",
              createdAt: "2026-09-01T00:00:00.000Z",
              blocksLeaseUntilPaid: false,
            },
          },
        ]);
      }
      if (table === "portal_work_order_records") {
        return Promise.resolve([
          {
            id: "wo-1",
            manager_user_id: "manager-1",
            property_id: "property-1",
            row_data: { id: "wo-1", bucket: "open" },
          },
        ]);
      }
      if (table === "portal_service_request_records") {
        return Promise.resolve([
          {
            id: "service-1",
            manager_user_id: "manager-1",
            property_id: "property-1",
            row_data: { id: "service-1", status: "pending" },
          },
        ]);
      }
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("counts the same four dashboard domains from server-loaded scoped rows", async () => {
    const summary = await loadManagerAttentionSummary({} as never, "manager-1");
    expect(summary).toEqual({
      unpaidCharges: 1,
      openWorkOrders: 1,
      pendingServiceRequests: 1,
      pendingApplications: 1,
      unsignedLeases: 1,
      total: 5,
    });
    expect(linkedIds).toHaveBeenCalledWith(expect.anything(), "manager-1", "payments");
    expect(linkedIds).toHaveBeenCalledWith(expect.anything(), "manager-1", "services");
  });

  it("renders counts and a portal link without SMS action tokens", () => {
    const text = renderManagerAttentionDigest(
      {
        unpaidCharges: 1,
        openWorkOrders: 2,
        pendingServiceRequests: 1,
        pendingApplications: 3,
        unsignedLeases: 1,
        total: 8,
      },
      "https://prop-lane.space/portal",
    );
    expect(text).toContain("1 unpaid charge");
    expect(text).toContain("2 open work orders");
    expect(text).toContain("3 pending applications");
    expect(text).toContain("https://prop-lane.space/portal");
    expect(text).not.toMatch(/\b(?:YES|APPROVE|PAY|COMPLETE)\b/);
  });

  it("routes one idempotent, traced digest through the manager's configured destination", async () => {
    const result = await deliverManagerAttentionDigest({
      db: {} as never,
      managerUserId: "manager-1",
      cadence: "daily",
      portalUrl: "https://prop-lane.space/portal",
      now: new Date("2026-09-04T14:00:00.000Z"),
    });

    expect(result.sent).toBe(true);
    expect(notifyManager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        landlordId: "manager-1",
        category: "attention_digest",
        idempotencyKey: "manager-attention-digest:2026-09-04",
        url: "/portal",
      }),
    );
    expect(traceSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "manager_attention_digest",
        managerUserId: "manager-1",
        cadence: "daily",
      }),
    );
  });

  it("runs weekly only on Monday UTC and uses a stable week key", () => {
    const monday = new Date("2026-09-07T14:00:00.000Z");
    const tuesday = new Date("2026-09-08T14:00:00.000Z");
    expect(managerAttentionDigestDue("daily", tuesday)).toBe(true);
    expect(managerAttentionDigestDue("weekly", monday)).toBe(true);
    expect(managerAttentionDigestDue("weekly", tuesday)).toBe(false);
    expect(managerAttentionDigestPeriodKey("weekly", tuesday)).toBe("week-2026-09-07");
  });
});
