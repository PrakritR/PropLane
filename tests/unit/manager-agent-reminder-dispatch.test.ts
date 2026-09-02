import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/reminders/queue.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reminders/queue.server")>();
  return { ...actual, resolveReminder: vi.fn().mockResolvedValue(true) };
});

import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { dispatchReminderRow } from "@/lib/reminders/dispatch.server";
import { resolveReminder, type ReminderQueueRow } from "@/lib/reminders/queue.server";

const db = {} as SupabaseClient;

function managerRow(over: Partial<ReminderQueueRow> = {}): ReminderQueueRow {
  return {
    id: "reminder-1",
    managerUserId: "manager-1",
    kind: "task",
    subjectId: "task-1",
    leadMinutes: 60,
    recipientEmail: "manager@example.com",
    recipientRole: "manager",
    sendAt: "2026-09-02T15:00:00.000Z",
    attempts: 1,
    payload: {
      title: "Countersign lease",
      whenLabel: "Wed, Sep 2, 9:00 AM",
      recipientName: "Morgan",
      url: "https://prop-lane.space/portal/tasks",
      notificationCategory: "leasing",
    },
    ...over,
  };
}

describe("manager agent reminder dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes a manager-self reminder through PropLane Assistant preferences", async () => {
    await expect(
      dispatchReminderRow(
        db,
        "worker-1",
        managerRow(),
        { userId: "manager-1", email: "manager@example.com", name: "Morgan" },
        { inbox: true, email: true, sms: false },
      ),
    ).resolves.toBe("sent");

    expect(notifyManagerFromAgent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        landlordId: "manager-1",
        threadType: "agent_reminder",
        category: "leasing",
        subject: expect.stringContaining("Countersign lease"),
      }),
    );
    expect(resolveReminder).toHaveBeenCalledWith(db, "reminder-1", "worker-1", "sent");
  });

  it("releases the queue row for retry when manager delivery throws", async () => {
    vi.mocked(notifyManagerFromAgent).mockRejectedValueOnce(new Error("temporary outage"));

    await expect(
      dispatchReminderRow(
        db,
        "worker-1",
        managerRow(),
        { userId: "manager-1", email: "manager@example.com", name: "Morgan" },
        { inbox: true, email: true, sms: false },
      ),
    ).resolves.toBe("retried");

    expect(resolveReminder).toHaveBeenCalledWith(
      db,
      "reminder-1",
      "worker-1",
      "scheduled",
      "temporary outage",
    );
  });
});
