// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHouseholdCharges, recordHouseholdChargeOfflinePayment, seedDemoHouseholdCharges, resetHouseholdViewerRoleForTests, type HouseholdCharge } from "@/lib/household-charges";
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
const charge = { id: "offline-test", managerUserId: "manager", propertyId: "property", residentEmail: "resident@example.test", residentName: "Resident", residentUserId: null, propertyLabel: "House", kind: "rent", title: "Rent", status: "pending", amountLabel: "$12.34", balanceLabel: "$12.34", createdAt: "2026-01-01T00:00:00Z", blocksLeaseUntilPaid: false } satisfies HouseholdCharge;
const receipt = { paidAt: "2026-01-02T12:00:00Z", method: "Check" as const, note: " Check 42 " };
beforeEach(() => { sessionStorage.clear(); resetHouseholdViewerRoleForTests(); seedDemoHouseholdCharges([charge]); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ charge: { ...charge, status: "paid", balanceLabel: "$0.00", paidAt: "2026-01-02T12:00:00.000Z", paidMethod: "Check", paidNote: "Check 42" } }), { status: 200 }))); });
afterEach(() => vi.unstubAllGlobals());
describe("offline charge receipt", () => {
  it("awaits acceptance and preserves exact face value, date, method and note", async () => {
    expect(await recordHouseholdChargeOfflinePayment(charge.id, "manager", receipt)).toBe(true);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).not.toHaveProperty("charges");
    expect(readHouseholdCharges()[0]).toMatchObject({ status: "paid", amountLabel: "$12.34", balanceLabel: "$0.00", paidAt: "2026-01-02T12:00:00.000Z", paidMethod: "Check", paidNote: "Check 42" });
  });
  it("leaves the charge unpaid when the server rejects the receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await recordHouseholdChargeOfflinePayment(charge.id, "manager", receipt)).toBe(false);
    expect(readHouseholdCharges()[0].status).toBe("pending");
  });
  it("refuses another manager, a future date, and a processing charge", async () => {
    expect(await recordHouseholdChargeOfflinePayment(charge.id, "other", receipt)).toBe(false);
    expect(await recordHouseholdChargeOfflinePayment(charge.id, "manager", { ...receipt, paidAt: "2999-01-01" })).toBe(false);
    seedDemoHouseholdCharges([{ ...charge, status: "processing" }]);
    expect(await recordHouseholdChargeOfflinePayment(charge.id, "manager", receipt)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
