import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN,
  isUpcomingScheduledInboxMessage,
  isResidentOriginatedScheduledRow,
  updateScheduledInboxMessage,
} from "@/lib/scheduled-inbox-messages";

function mockDbForUpdate(rowData: Record<string, unknown>) {
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  });
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { row_data: rowData, status: "scheduled" },
    error: null,
  });
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle }),
      }),
    }),
    update,
  });
  return { from, update };
}

describe("updateScheduledInboxMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks manager content edits on resident-originated scheduled messages", async () => {
    const { from } = mockDbForUpdate({
      senderPortal: "resident",
      senderUserId: "res-1",
      subject: "Original",
      body: "Resident draft",
    });

    await expect(
      updateScheduledInboxMessage({ from } as never, "mgr-1", "msg-1", { subject: "Forged subject" }),
    ).rejects.toThrow(RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN);
  });

  it("blocks manager content edits on legacy resident rows without senderPortal", async () => {
    const { from } = mockDbForUpdate({
      senderUserId: "res-1",
      subject: "Original",
      body: "Resident draft",
    });

    await expect(
      updateScheduledInboxMessage({ from } as never, "mgr-1", "msg-1", { body: "Forged body" }),
    ).rejects.toThrow(RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN);
  });

  it("detects legacy resident rows via senderUserId", () => {
    expect(isResidentOriginatedScheduledRow({ senderUserId: "res-1" })).toBe(true);
    expect(isResidentOriginatedScheduledRow({ senderPortal: "manager" })).toBe(false);
  });

  it("keeps a held sending occurrence visible after its scheduled date", () => {
    expect(isUpcomingScheduledInboxMessage("2020-01-01T00:00:00.000Z", "sending")).toBe(true);
  });

  it("allows manager cancel on resident-originated scheduled messages", async () => {
    const { from, update } = mockDbForUpdate({
      senderPortal: "resident",
      senderUserId: "res-1",
      subject: "Original",
      body: "Resident draft",
    });

    await updateScheduledInboxMessage({ from } as never, "mgr-1", "msg-1", {
      status: "cancelled",
      cancelledAt: "2026-07-06T12:00:00.000Z",
    });

    expect(update).toHaveBeenCalled();
  });

  it("allows manager content edits on manager-originated scheduled messages", async () => {
    const { from, update } = mockDbForUpdate({
      senderPortal: "manager",
      subject: "Original",
      body: "Manager draft",
    });

    await updateScheduledInboxMessage({ from } as never, "mgr-1", "msg-1", { subject: "Updated subject" });

    expect(update).toHaveBeenCalled();
  });
});
