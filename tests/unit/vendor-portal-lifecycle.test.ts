import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { vendorWorkOrderTab } from "@/lib/vendor-work-order-tabs";
import { managerCanPayOutgoingRowWithMethod, enrichOutgoingRowWithVendorPayments } from "@/lib/manager-vendor-payment-flow";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { loadVendorAssignedTasks, patchVendorAssignedTask } from "@/lib/vendor-tasks.server";
import { managerTasksStorageKey } from "@/lib/manager-tasks";

function vendorRow(overrides: Partial<ManagerVendorRow> = {}): ManagerVendorRow {
  return {
    id: "vendor-dir-1",
    managerUserId: "mgr-1",
    name: "Ace HVAC",
    trade: "HVAC",
    phone: "",
    email: "",
    notes: "",
    active: true,
    zellePaymentsEnabled: true,
    zelleContact: "ace@email.com",
    venmoPaymentsEnabled: false,
    venmoContact: "",
    achPaymentsEnabled: true,
    ...overrides,
  };
}

function workOrder(partial: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "Oak",
    unit: "1A",
    title: "Fix AC",
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: "",
    scheduled: "",
    cost: "$120.00",
    biddingOpen: true,
    ...partial,
  };
}

function mockTasksDb(input: {
  vendorLinks?: { id: string; manager_user_id: string; row_data: Record<string, unknown> }[];
  tasksByManager?: Record<string, { row_data: { tasks: unknown[] } }>;
}) {
  return {
    from(table: string) {
      const state: Record<string, unknown> = {};
      if (table === "manager_vendor_records") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: async () => ({
                  data: input.vendorLinks ?? [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      const api = {
        select: () => api,
        eq: (col: string, val: string) => {
          state[col] = val;
          return api;
        },
        maybeSingle: async () => {
          if (table === "portal_schedule_records") {
            const id = state.id as string;
            for (const [managerUserId, record] of Object.entries(input.tasksByManager ?? {})) {
              if (id === managerTasksStorageKey(managerUserId)) {
                return { data: record, error: null };
              }
            }
            return { data: null, error: null };
          }
          if (table === "profiles") {
            return { data: { full_name: "Alex Manager" }, error: null };
          }
          return { data: null, error: null };
        },
        upsert: async () => ({ error: null }),
      };
      return api;
    },
  } as never;
}

describe("vendor portal lifecycle", () => {
  it("manager assigns task → vendor loads and completes it", async () => {
    const db = mockTasksDb({
      vendorLinks: [{ id: "vendor-dir-1", manager_user_id: "mgr-1", row_data: {} }],
      tasksByManager: {
        "mgr-1": {
          row_data: {
            tasks: [
              {
                id: "task-1",
                title: "Replace filter",
                completed: false,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                assignee: { type: "vendor", id: "vendor-dir-1", name: "Ace HVAC" },
              },
            ],
          },
        },
      },
    });

    const assigned = await loadVendorAssignedTasks(db, "vendor-user-1");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.completed).toBe(false);

    const saved = await patchVendorAssignedTask(db, "vendor-user-1", {
      managerUserId: "mgr-1",
      taskId: "task-1",
      completed: true,
    });
    expect(saved.completed).toBe(true);
  });

  it("service order quote → scheduled → completed → manager can pay", () => {
    expect(vendorWorkOrderTab(workOrder({ biddingOpen: true }))).toBe("quote");
    expect(
      vendorWorkOrderTab(
        workOrder({
          bucket: "scheduled",
          biddingOpen: false,
          vendorCostCents: 12_000,
          scheduledAtIso: "2026-08-12T10:00:00.000Z",
        }),
      ),
    ).toBe("scheduled");
    expect(
      vendorWorkOrderTab(
        workOrder({
          bucket: "completed",
          automationStatus: "vendor_marked_done",
        }),
      ),
    ).toBe("completed");

    const enriched = enrichOutgoingRowWithVendorPayments(
      {
        id: "wo-1",
        propertyName: "Oak",
        categoryLabel: "Vendor payment",
        payeeLabel: "Ace HVAC",
        chargeTitle: "Fix AC",
        amountLabel: "$120.00",
        dueDate: "Aug 12",
        bucket: "pending",
        statusLabel: "Awaiting approval",
        workOrderId: "wo-1",
      },
      vendorRow(),
    );
    expect(managerCanPayOutgoingRowWithMethod(enriched, "zelle")).toBe(true);
    expect(managerCanPayOutgoingRowWithMethod({ ...enriched, bucket: "paid" }, "zelle")).toBe(false);
  });
});
