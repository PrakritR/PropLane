import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import { sendRentReminderTool } from "@/lib/tools/domains/payments";
import { makeManagerRowsCtx, managerRow, previewWrite } from "./fake-agent-ctx";

/**
 * PRP-270: "remind John about rent" must come back as a confirm card, through
 * the REAL preview gate (`previewWriteTool` via the fake-ctx `previewWrite`
 * helper) — Zod validation, ownership, overdue check, the fields the card
 * renders — not a direct call to the tool's `preview`.
 */
function charge(overrides: Partial<HouseholdCharge> & { id: string }): HouseholdCharge {
  return {
    createdAt: "2026-08-01T00:00:00.000Z",
    residentEmail: "john@example.com",
    residentName: "John Resident",
    residentUserId: null,
    propertyId: "cascade",
    propertyLabel: "Cascade Lofts",
    managerUserId: "manager_a",
    kind: "rent",
    title: "Rent — August 2026",
    amountLabel: "$1,200.00",
    balanceLabel: "$1,200.00",
    status: "pending",
    dueDateLabel: "Aug 1, 2026",
    ...overrides,
  } as HouseholdCharge;
}

const TABLE = "portal_household_charge_records";

describe("send_rent_reminder through the preview gate (PRP-270)", () => {
  it("produces a confirm card naming the resident, the charge and the balance", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [managerRow("manager_a", charge({ id: "c_overdue" }))],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_overdue"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.title).toBe("Send rent reminder");
    expect(res.preview.confirmLabel).toBe("Send reminder");
    expect(res.preview.fields).toEqual([{ label: "John Resident", value: "Rent — August 2026 ($1,200.00)" }]);
    expect(res.preview.summary).toContain("John Resident");
    expect(res.preview.summary).toContain("$1,200.00");
  });

  it("refuses a charge that is paid, and one that is not yet due", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [
        managerRow("manager_a", charge({ id: "c_paid", status: "paid", paidAt: "2026-08-02T00:00:00.000Z", balanceLabel: "$0.00" })),
        managerRow("manager_a", charge({ id: "c_future", dueDateLabel: "Jan 1, 2999" })),
      ],
    });
    expect((await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_paid"] })).ok).toBe(false);
    expect((await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_future"] })).ok).toBe(false);
  });

  it("never previews another landlord's charge, even with a valid id", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [managerRow("manager_b", charge({ id: "c_theirs", managerUserId: "manager_b" }))],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c_theirs"] });
    expect(res.ok).toBe(false);
  });

  it("batches several overdue charges into one card with a count", async () => {
    const ctx = makeManagerRowsCtx({
      [TABLE]: [
        managerRow("manager_a", charge({ id: "c1" })),
        managerRow("manager_a", charge({ id: "c2", residentName: "Olivia Brooks", residentEmail: "olivia@example.com" })),
      ],
    });
    const res = await previewWrite(sendRentReminderTool, ctx, { chargeIds: ["c1", "c2", "c1"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.title).toBe("Send rent reminders");
    expect(res.preview.confirmLabel).toBe("Send 2 reminders");
    expect(res.preview.fields).toHaveLength(2);
  });
});
