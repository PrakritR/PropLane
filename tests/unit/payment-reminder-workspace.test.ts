import { describe, expect, it } from "vitest";
import { paymentReminderSnapshotMatches, resolveReminderWorkspaceOwner } from "@/lib/payment-reminder-workspace";
import type { HouseholdCharge } from "@/lib/household-charges";

describe("payment reminder workspace ownership", () => {
  it("uses the property owner even when a co-manager created the charge", () => {
    const owners = new Map([["home-1", { ok: true as const, ownerUserId: "owner" }]]);
    expect(resolveReminderWorkspaceOwner(owners, "home-1", "co-manager")).toBe("owner");
  });

  it("fails closed for missing, ownerless, or unreadable property records", () => {
    const owners = new Map([
      ["ownerless", { ok: true as const, ownerUserId: null }],
      ["unreadable", { ok: false as const, reason: "lookup_failed" as const }],
    ]);
    expect(resolveReminderWorkspaceOwner(owners, "missing", "co-manager")).toBeNull();
    expect(resolveReminderWorkspaceOwner(owners, "ownerless", "co-manager")).toBeNull();
    expect(resolveReminderWorkspaceOwner(owners, "unreadable", "co-manager")).toBeNull();
    expect(resolveReminderWorkspaceOwner(owners, "", "legacy-owner")).toBe("legacy-owner");
  });

  it("rejects a paid or changed balance before reminder delivery", () => {
    const charge = {
      id: "charge-1", propertyId: "home-1", residentEmail: "resident@example.com",
      amountLabel: "$100.00", balanceLabel: "$100.00", title: "Rent", status: "pending",
    } as HouseholdCharge;
    expect(paymentReminderSnapshotMatches(charge, { ...charge })).toBe(true);
    expect(paymentReminderSnapshotMatches(charge, { ...charge, balanceLabel: "$50.00" })).toBe(false);
    expect(paymentReminderSnapshotMatches(charge, { ...charge, status: "paid" })).toBe(false);
  });
});
