import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceClient, workOrderEvent, prepareDispatch, resolveManagerRecipients } = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  workOrderEvent: vi.fn().mockResolvedValue({ eventId: "event-1", duplicate: false, delivered: 2, deferred: 0, failed: 0 }),
  prepareDispatch: vi.fn().mockResolvedValue(undefined),
  resolveManagerRecipients: vi.fn().mockResolvedValue(["manager-1", "co-manager-1"]),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: serviceClient,
}));

vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: resolveManagerRecipients,
}));

import { createWorkOrderFromResidentSms } from "@/lib/claw-maintenance-work-order.server";

describe("createWorkOrderFromResidentSms action event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the DB-stamped reference and emits manager + resident recipients", async () => {
    const recentQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const workOrderWrite = {
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { row_data: { reference: "WO-1042" } },
            error: null,
          }),
        }),
      }),
    };
    let workOrderReads = 0;
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "portal_work_order_records") {
          workOrderReads++;
          return workOrderReads === 1 ? recentQuery : workOrderWrite;
        }
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { full_name: "Riley Resident" } }),
              }),
            }),
          };
        }
        if (table === "manager_application_records") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  property_id: "property-1",
                  row_data: { assignedPropertyId: "property-1", assignedRoomChoice: "2A" },
                },
              }),
            }),
          };
        }
        if (table === "manager_property_records") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { property_data: { buildingName: "Oak House", address: "1 Oak St" } },
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    serviceClient.mockReturnValue(db);

    const result = await createWorkOrderFromResidentSms({
      managerUserId: "manager-1",
      residentPhone: "+12065550123",
      residentUserId: "resident-1",
      residentEmail: "resident@example.com",
      text: "My kitchen sink is leaking under the cabinet",
      senderUserId: "resident-1",
    });

    expect(result).toMatchObject({ created: true, reference: "WO-1042" });
    expect(resolveManagerRecipients).toHaveBeenCalledWith(db, {
      ownerManagerUserId: "manager-1",
      propertyId: "property-1",
      channel: "services",
    });
    expect(workOrderEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event: "created",
        managerUserId: "manager-1",
        senderUserId: "resident-1",
        facts: expect.objectContaining({ reference: "WO-1042" }),
        recipients: [
          { audience: "manager", userId: "manager-1" },
          { audience: "manager", userId: "co-manager-1" },
          { audience: "resident", userId: "resident-1" },
        ],
      }),
    );
    expect(prepareDispatch).toHaveBeenCalledOnce();
  });
});
