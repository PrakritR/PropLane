import { describe, expect, it } from "vitest";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";

function manual(partial: Partial<ScheduledInboxMessageRecord> & Pick<ScheduledInboxMessageRecord, "id">): ScheduledInboxMessageRecord {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    managerUserId: "mgr-1",
    sendAt: tomorrow.toISOString(),
    status: "scheduled",
    subject: "Reminder",
    body: "Body",
    recipientEmail: "dana@example.com",
    recipientName: "Dana",
    deliverViaEmail: true,
    deliverViaSms: false,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function automation(partial: Partial<ScheduledPaymentMessage> & Pick<ScheduledPaymentMessage, "id">): ScheduledPaymentMessage {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  return {
    chargeId: "chg-1",
    kind: "pre_due",
    daysBeforeDue: 3,
    sendAt: tomorrow.toISOString(),
    visibleFrom: new Date().toISOString(),
    dueDate: null,
    dueDateLabel: "",
    residentName: "Dana",
    residentEmail: "dana@example.com",
    chargeTitle: "Rent",
    propertyLabel: "Maple 2A",
    balanceDue: "$1,200",
    subject: "Rent due soon",
    body: "Your rent is due",
    status: "scheduled",
    managerUserId: "mgr-1",
    typeLabel: "Pre-due reminder",
    ...partial,
  };
}

describe("scheduledItemsForRecipient (inline in the person's thread)", () => {
  it("matches by recipient email (case-insensitive) and drops others", () => {
    const items = scheduledItemsForRecipient(
      "Dana@Example.com",
      [manual({ id: "m1" }), manual({ id: "m2", recipientEmail: "other@example.com" })],
      [automation({ id: "a1" }), automation({ id: "a2", residentEmail: "someone@else.com" })],
    );
    expect(items.map((i) => i.id).sort()).toEqual(["a1", "m1"]);
  });

  it("drops cancelled and sent rows — the thread shows only what is pending", () => {
    const items = scheduledItemsForRecipient(
      "dana@example.com",
      [manual({ id: "m1", status: "cancelled" }), manual({ id: "m2", status: "sent" }), manual({ id: "m3" })],
      [automation({ id: "a1", status: "cancelled" })],
    );
    expect(items.map((i) => i.id)).toEqual(["m3"]);
  });

  it("marks resident-originated manual rows non-editable (manager may cancel, not rewrite)", () => {
    const items = scheduledItemsForRecipient(
      "dana@example.com",
      [
        manual({ id: "mine" }),
        manual({ id: "theirs", senderPortal: "resident", senderUserId: "res-9" }),
      ],
      [],
    );
    expect(items.find((i) => i.id === "mine")?.editable).toBe(true);
    expect(items.find((i) => i.id === "theirs")?.editable).toBe(false);
  });

  it("tags a channel on every item (email today) and sorts by send time", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 1);
    const later = new Date();
    later.setDate(later.getDate() + 5);
    const items = scheduledItemsForRecipient(
      "dana@example.com",
      [manual({ id: "late", sendAt: later.toISOString() }), manual({ id: "early", sendAt: soon.toISOString() })],
      [],
    );
    expect(items.map((i) => i.id)).toEqual(["early", "late"]);
    expect(items.every((i) => i.channel === "email")).toBe(true);
  });

  it("combines several payment reminders for the same send slot into one thread row", () => {
    const sendAt = new Date();
    sendAt.setDate(sendAt.getDate() + 2);
    const iso = sendAt.toISOString();
    const items = scheduledItemsForRecipient(
      "dana@example.com",
      [],
      [
        automation({ id: "a1", chargeId: "chg-1", chargeTitle: "Lease", sendAt: iso }),
        automation({ id: "a2", chargeId: "chg-2", chargeTitle: "Deposit", sendAt: iso }),
        automation({ id: "a3", chargeId: "chg-3", chargeTitle: "Move-in", sendAt: iso }),
      ],
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.subject).toContain("3 payments");
  });
});
