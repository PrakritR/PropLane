import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_REMINDER_RULES } from "@/lib/reminders/rules";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";

/**
 * A3 decision 4. The welcome sequence is ON by default and is delivered as the Move-in details card. It goes
 * through `emitMoveInDetails` (idempotent per resident and home), never through the generic reminder wording,
 * so turning it on cannot send a second card next to a manager's own move-in details.
 */
const resolveReminder = vi.fn(async () => true);
vi.mock("@/lib/reminders/queue.server", () => ({
  claimDueReminders: vi.fn(),
  resolveReminder: (...args: unknown[]) => resolveReminder(...(args as [])),
}));
vi.mock("@/lib/reminders/current.server", () => ({ reminderIsCurrent: vi.fn(async () => true) }));
const deliverPortalInboxMessage = vi.fn(async () => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliverPortalInboxMessage(...(args as [])),
}));
const emitMoveInDetails = vi.fn();
vi.mock("@/lib/move-in-details-event.server", () => ({
  emitMoveInDetails: (...args: unknown[]) => emitMoveInDetails(...(args as [])),
}));

import { dispatchReminderRow } from "@/lib/reminders/dispatch.server";

const sender = { userId: "mgr-1", email: "ambika@example.com", name: "Ambika" };
const row = {
  id: "rem-1",
  managerUserId: "mgr-1",
  kind: "resident_welcome",
  subjectId: "res-1",
  leadMinutes: 5,
  recipientEmail: "maya@example.com",
  recipientRole: "counterparty",
  payload: { title: "welcome", recipientUserId: "res-1" },
} as unknown as ReminderQueueRow;
const channels = { inbox: true, email: true, sms: false };
const db = {} as SupabaseClient;

describe("resident_welcome is the Move-in details card", () => {
  beforeEach(() => {
    resolveReminder.mockClear();
    deliverPortalInboxMessage.mockClear();
    emitMoveInDetails.mockReset();
  });

  it("is on by default with a single timing", () => {
    expect(DEFAULT_REMINDER_RULES.resident_welcome.enabled).toBe(true);
    expect(DEFAULT_REMINDER_RULES.resident_welcome.timings).toEqual(["after:5"]);
    expect(DEFAULT_REMINDER_RULES.resident_welcome.audience.counterparty).toBe(true);
  });

  it("sends the card through the idempotent move-in event and never through the generic reminder text", async () => {
    emitMoveInDetails.mockResolvedValue({ ok: true, duplicate: false });
    expect(await dispatchReminderRow(db, "w1", row, sender, channels)).toBe("sent");
    expect(emitMoveInDetails).toHaveBeenCalledWith(db, {
      managerUserId: "mgr-1",
      residentEmail: "maya@example.com",
      residentUserId: "res-1",
      sender,
    });
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
    expect(resolveReminder).toHaveBeenCalledWith(db, "rem-1", "w1", "sent");
  });

  it("a card already sent by the manager is a duplicate the bus drops, and the reminder is simply done", async () => {
    emitMoveInDetails.mockResolvedValue({ ok: true, duplicate: true });
    expect(await dispatchReminderRow(db, "w1", row, sender, channels)).toBe("sent");
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });

  it("a resident with no placed home is not told anything untrue: the row ends, it does not spin", async () => {
    emitMoveInDetails.mockResolvedValue({ ok: false, reason: "no_home" });
    expect(await dispatchReminderRow(db, "w1", row, sender, channels)).toBe("failed");
    expect(resolveReminder).toHaveBeenCalledWith(db, "rem-1", "w1", "failed", expect.stringContaining("no_home"));
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });

  it("a transient failure retries", async () => {
    emitMoveInDetails.mockRejectedValue(new Error("db down"));
    expect(await dispatchReminderRow(db, "w1", row, sender, channels)).toBe("retried");
    expect(resolveReminder).toHaveBeenCalledWith(db, "rem-1", "w1", "scheduled", "db down");
  });
});
