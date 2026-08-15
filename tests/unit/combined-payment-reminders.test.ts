import { describe, expect, it } from "vitest";
import {
  buildCombinedPaymentReminderContent,
  combineScheduledPaymentMessages,
} from "@/lib/combined-payment-reminders";
import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";

function makeMessage(overrides: Partial<ScheduledPaymentMessage>): ScheduledPaymentMessage {
  return {
    id: "sched|hc-1|pre_due|3|2026-08-15",
    chargeId: "hc-1",
    kind: "pre_due",
    daysBeforeDue: 3,
    sendAt: "2026-08-15T17:00:00.000Z",
    visibleFrom: "2026-08-12T17:00:00.000Z",
    dueDate: "2026-08-18T17:00:00.000Z",
    dueDateLabel: "Aug 18, 2026",
    residentName: "Alex Resident",
    residentEmail: "alex@example.com",
    chargeTitle: "Custom Lease",
    propertyLabel: "QA Madison Studio",
    balanceDue: "$1,200.00",
    subject: "Payment due in 3 days: Custom Lease",
    body: "Hi Alex,\n\nPropLane Portal",
    status: "scheduled",
    managerUserId: "mgr-1",
    typeLabel: "3 days before due",
    ...overrides,
  };
}

describe("combineScheduledPaymentMessages", () => {
  it("merges reminders for the same resident, send time, and reminder slot", () => {
    const messages = combineScheduledPaymentMessages([
      makeMessage({ chargeId: "hc-1", chargeTitle: "Custom Lease", balanceDue: "$1,200.00" }),
      makeMessage({
        id: "sched|hc-2|pre_due|3|2026-08-15",
        chargeId: "hc-2",
        chargeTitle: "Security deposit",
        balanceDue: "$500.00",
      }),
      makeMessage({
        id: "sched|hc-3|pre_due|3|2026-08-15",
        chargeId: "hc-3",
        chargeTitle: "Move-in cost",
        balanceDue: "$350.00",
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.bundledChargeIds).toEqual(["hc-1", "hc-3", "hc-2"]);
    expect(messages[0]!.subject).toBe("Payment due in 3 days (3 payments)");
    expect(messages[0]!.body).toContain("Custom Lease — $1,200.00");
    expect(messages[0]!.body).toContain("Security deposit — $500.00");
    expect(messages[0]!.body).toContain("Move-in cost — $350.00");
  });

  it("keeps separate rows when send times differ", () => {
    const messages = combineScheduledPaymentMessages([
      makeMessage({ chargeId: "hc-1" }),
      makeMessage({
        id: "sched|hc-2|pre_due|2|2026-08-16",
        chargeId: "hc-2",
        daysBeforeDue: 2,
        sendAt: "2026-08-16T17:00:00.000Z",
      }),
    ]);

    expect(messages).toHaveLength(2);
  });
});

describe("buildCombinedPaymentReminderContent", () => {
  it("uses concise same-day copy for one payment", () => {
    const content = buildCombinedPaymentReminderContent([
      makeMessage({
        kind: "same_day",
        daysBeforeDue: null,
        subject: "Payment due today: Custom Lease",
      }),
    ]);
    expect(content.subject).toContain("Custom Lease");
    expect(content.body).toContain("due today");
  });
});
