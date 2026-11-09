// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("confirms only mutable application and matching recurring rows, and refuses incomplete acknowledgments", async () => {
  const { seedDemoHouseholdCharges, mirrorApplicationHouseholdChargesAwait } = await import("@/lib/household-charges");
  const base = { residentEmail: "r@example.invalid", residentName: "R", residentUserId: null, propertyId: "p", propertyLabel: "P", managerUserId: "owner", status: "pending", createdAt: "2026-01-01", kind: "rent", title: "Rent", amountLabel: "$1", balanceLabel: "$1", blocksLeaseUntilPaid: false } as HouseholdCharge;
  const profile = { id: "profile", residentEmail: base.residentEmail, residentName: "R", residentUserId: null, propertyId: "p", propertyLabel: "P", roomLabel: "R", managerUserId: "owner", monthlyRent: 1 } as RecurringRentProfile;
  seedDemoHouseholdCharges([
    { ...base, id: "app-charge", applicationId: "app", kind: "security_deposit" },
    { ...base, id: "recurring", recurringRentProfileId: "profile", rentMonth: "2026-01" },
    { ...base, id: "paid", applicationId: "app", status: "paid" },
    { ...base, id: "old-pending", residentEmail: "old@example.invalid", propertyId: "old-p", rentMonth: "2026-02", recurringRentProfileId: "old-profile", status: "pending" },
    { ...base, id: "old-cancelled", residentEmail: "old@example.invalid", propertyId: "old-p", rentMonth: "2026-03", recurringRentProfileId: "old-profile", status: "cancelled" },
    { ...base, id: "old-paid", residentEmail: "old@example.invalid", propertyId: "old-p", rentMonth: "2026-04", recurringRentProfileId: "old-profile", status: "paid" },
    { ...base, id: "other", applicationId: "other" },
  ], [profile, { ...profile, id: "old-profile", residentEmail: "old@example.invalid", propertyId: "old-p" }]);
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, confirmedChargeIds: ["app-charge"], confirmedProfileIds: ["profile", "old-profile"] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, confirmedChargeIds: ["app-charge", "recurring", "old-pending", "old-cancelled"], confirmedProfileIds: ["profile", "old-profile"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const row = { id: "app", email: base.residentEmail, propertyId: "p", managerUserId: "owner" } as DemoApplicantRow;
  const previous = { ...row, email: "old@example.invalid", propertyId: "old-p" };
  expect(await mirrorApplicationHouseholdChargesAwait(row, previous)).toBe(false);
  expect(await mirrorApplicationHouseholdChargesAwait(row, previous)).toBe(true);
  const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
  expect(body.charges.map((charge: HouseholdCharge) => charge.id).sort()).toEqual(["app-charge", "old-cancelled", "old-pending", "recurring"]);
  expect(body.rentProfiles.map((item: RecurringRentProfile) => item.id)).toEqual(["profile", "old-profile"]);
  expect(body.charges.every((charge: HouseholdCharge) => charge.managerUserId === "owner")).toBe(true);
  expect(body.rentProfiles.every((item: RecurringRentProfile) => item.managerUserId === "owner")).toBe(true);
});

it("does not send a request for an empty target", async () => {
  const { seedDemoHouseholdCharges, mirrorApplicationHouseholdChargesAwait } = await import("@/lib/household-charges");
  seedDemoHouseholdCharges([], []);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  expect(await mirrorApplicationHouseholdChargesAwait({ id: "empty", email: "r@example.invalid", propertyId: "p", managerUserId: "owner" } as DemoApplicantRow)).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
