import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  recent: vi.fn(),
  dataUrls: vi.fn(),
  link: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: vi.fn().mockResolvedValue(["manager-1"]),
}));
vi.mock("@/lib/one-number/inbound-media.server", () => ({
  recentUnlinkedSmsMedia: mocks.recent,
  smsMediaDataUrls: mocks.dataUrls,
  linkClaimedMedia: mocks.link,
}));

import { createWorkOrderFromResidentSms } from "@/lib/claw-maintenance-work-order.server";

function makeDb() {
  const recentQuery = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  const write = {
    upsert: mocks.upsert.mockImplementation((row: Record<string, unknown>) => ({
      select: () => ({ maybeSingle: async () => ({ data: { row_data: (row as { row_data: unknown }).row_data }, error: null }) }),
    })),
  };
  let reads = 0;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "portal_work_order_records") return ++reads === 1 ? recentQuery : write;
      if (table === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Riley", phone: "+12065550123" } }) }) }) };
      if (table === "manager_application_records") {
        return { select: () => ({ eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: async () => ({ data: { property_id: "p1", row_data: { assignedPropertyId: "p1", assignedRoomChoice: "2A" } } }) }) };
      }
      if (table === "manager_property_records") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_data: { buildingName: "Oak House" } } }) }) }) };
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

const args = {
  managerUserId: "manager-1", residentPhone: "+12065550123", residentUserId: "resident-1",
  residentEmail: "r@example.com", text: "My kitchen sink is leaking under the cabinet", senderUserId: "resident-1",
};

describe("resident MMS photos go on the work order they file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serviceClient.mockReturnValue(makeDb());
    mocks.recent.mockReset().mockResolvedValue([{ id: "file-1" }, { id: "file-2" }]);
    mocks.dataUrls.mockReset().mockResolvedValue(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
    mocks.link.mockReset().mockResolvedValue(undefined);
  });

  it("claims the resident's recent photos, puts them on the record and links them to it", async () => {
    const result = await createWorkOrderFromResidentSms(args);
    expect(result).toMatchObject({ created: true });
    expect(mocks.recent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerUserId: "manager-1", senderPhone: "+12065550123" }));
    const rowData = mocks.upsert.mock.calls[0][0].row_data;
    expect(rowData.photoDataUrls).toEqual(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
    expect(mocks.link).toHaveBeenCalledWith(expect.anything(), {
      ids: ["file-1", "file-2"], linkedType: "work_order", linkedId: mocks.upsert.mock.calls[0][0].id,
    });
  });

  it("looks the phone up from the resident's profile for an agent filing, and keeps portal filings out of it", async () => {
    await createWorkOrderFromResidentSms({ ...args, residentPhone: "", attachRecentSmsPhotos: true });
    expect(mocks.recent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ senderPhone: "+12065550123" }));
    mocks.recent.mockClear();
    mocks.serviceClient.mockReturnValue(makeDb());
    await createWorkOrderFromResidentSms({ ...args, residentPhone: "" });
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls.at(-1)?.[0].row_data).not.toHaveProperty("photoDataUrls");
  });

  it("files the request without photos when the media lookup fails", async () => {
    mocks.recent.mockRejectedValue(new Error("boom"));
    const result = await createWorkOrderFromResidentSms(args);
    expect(result).toMatchObject({ created: true });
    expect(mocks.link).not.toHaveBeenCalled();
  });
});
