/**
 * "Why send 24 messages of the same payment reminder — 6 are repeated?"
 *
 * The captain counted 24 scheduled reminders for ONE resident. The projection
 * runs per CHARGE, so six charges due the same day against four reminder times
 * is 6 × 4 = 24 rows, even though the send side has always bundled them into
 * one message per person per slot. The schedule was describing sends that would
 * never happen that way.
 *
 * Grouping now happens where the messages are read, so the count a manager sees
 * is the count that goes out.
 */
import { describe, expect, it } from "vitest";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";
import { projectScheduledPaymentMessages } from "@/lib/scheduled-payment-messages";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import type { HouseholdCharge } from "@/lib/household-charges";

const DUE = "Oct 1, 2026";

const charge = (id: string, title: string): HouseholdCharge =>
  ({
    id,
    title,
    residentName: "Rae Resident",
    residentEmail: "rae@example.test",
    propertyLabel: "Alder Row",
    balanceLabel: "$100.00",
    dueDateLabel: DUE,
    status: "pending",
  }) as unknown as HouseholdCharge;

const SIX_CHARGES = [
  charge("c1", "Rent"),
  charge("c2", "Water"),
  charge("c3", "Electric"),
  charge("c4", "Parking"),
  charge("c5", "Storage"),
  charge("c6", "Internet"),
];

/** Four reminder times, which is what produced the captain's 6 x 4 = 24. */
const SETTINGS = {
  ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  preDueReminderDays: [14, 7, 3, 1],
};

function project() {
  return projectScheduledPaymentMessages({
    managerUserId: "mgr-1",
    charges: SIX_CHARGES,
    settings: SETTINGS,
    includeHidden: true,
    now: new Date("2026-09-01T09:00:00"),
  });
}

describe("scheduled reminders for one resident with several charges", () => {
  it("projects one row per charge per reminder time — the raw shape", () => {
    // Not the bug: this is the projection doing its job, charge by charge.
    // Six charges against four reminder times is the captain's 24.
    const raw = project();
    const preDue = raw.filter((m) => m.kind === "pre_due");
    expect(preDue.length).toBe(SIX_CHARGES.length * SETTINGS.preDueReminderDays.length);
  });

  it("collapses to one message per send slot once grouped", () => {
    const grouped = combineScheduledPaymentMessages(project());

    // Every remaining row is unique on (recipient, kind, slot).
    const slots = grouped.map((m) => `${m.residentEmail}|${m.kind}|${m.daysBeforeDue}|${m.sendAt}`);
    expect(new Set(slots).size).toBe(slots.length);

    // The captain's 24 pre-due rows become four — one per reminder time.
    expect(grouped.filter((m) => m.kind === "pre_due").length).toBe(
      SETTINGS.preDueReminderDays.length,
    );
  });

  it("keeps every charge accounted for — grouping must not drop one", () => {
    const grouped = combineScheduledPaymentMessages(project());
    const covered = new Set(
      grouped.flatMap((m) => (m.bundledChargeIds?.length ? m.bundledChargeIds : [m.chargeId])),
    );
    for (const c of SIX_CHARGES) expect(covered.has(c.id)).toBe(true);
  });

  it("is idempotent, so a caller that groups again changes nothing", () => {
    // The two panels that already grouped downstream must stay unaffected.
    const once = combineScheduledPaymentMessages(project());
    const twice = combineScheduledPaymentMessages(once);
    expect(twice.map((m) => m.id).sort()).toEqual(once.map((m) => m.id).sort());
  });
});

/**
 * One bucket order, everywhere.
 *
 * The resident detail Payments tab listed Overdue / Pending / Paid while the
 * portfolio page, both route parsers and the captain's own words read
 * Pending / Overdue / Paid. Reading the shared constant rather than re-typing
 * the array is what keeps the two from drifting again.
 */
describe("payment bucket order", () => {
  it("is the shared constant on the resident detail tab", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");
    expect(src).toMatch(/PAYMENT_BUCKETS\.map\(\(id\) => \(\{/);
    expect(src).not.toContain('["overdue", "pending", "paid"]');
  });

  it("reads pending, overdue, paid", async () => {
    const { PAYMENT_BUCKETS } = await import("@/lib/portal-detail-routes");
    expect([...PAYMENT_BUCKETS]).toEqual(["pending", "overdue", "paid"]);
  });
});
