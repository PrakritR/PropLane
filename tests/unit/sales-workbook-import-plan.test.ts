import { describe, expect, it } from "vitest";
import { planPropertyImport, summarisePlan } from "@/lib/sales-workbook-import-plan";
import type { RosterRoom } from "@/lib/sales-workbook-roster";
const room = (over: Partial<RosterRoom> = {}): RosterRoom => ({ room: "Room 1", roomNumber: 1, occupancy: "resident", residentName: "Resident", residentEmail: "resident@example.test", residentPhone: "", monthlyRent: 1100, monthlyUtilities: 175, cleaningFee: 25, depositHeld: 600, leaseStartIso: "2026-08-21", leaseEndIso: "2026-10-31", monthToMonth: false, moveInCode: "SECRET", ...over });
describe("Sales roster planning", () => {
  it("records rates as terms and held money as already held, never new debt", () => {
    const plan = planPropertyImport("p", [room()]);
    expect(summarisePlan(plan)).toEqual({ room: 1, account: 1, lease: 1, terms: 3, held_deposit: 1 });
    expect(plan.actions.find(a => a.type === "held_deposit")).toMatchObject({ amountCents: 60000, requiresReceiptDate: true });
    expect(plan.actions.some(a => (a.type as string) === "charge")).toBe(false);
  });
  it("preserves physical vacant rooms without asserting occupants", () => {
    expect(planPropertyImport("p", [room({ occupancy: "vacant" })]).actions.map(a => a.type)).toEqual(["room"]);
  });
  it("does not turn a short-term occupant into a long-term debtor", () => {
    const plan = planPropertyImport("p", [room({ occupancy: "short-term" })]);
    expect(plan.actions.map(a => a.type)).toEqual(["room", "account"]);
  });
  it("blocks missing identity and contractual dates", () => {
    const plan = planPropertyImport("p", [room({ residentEmail: "", leaseEndIso: "" })]);
    expect(plan.actions.find(a => a.type === "account")).toMatchObject({ ready: false });
    expect(plan.actions.find(a => a.type === "lease")).toMatchObject({ ready: false });
  });
  it("keeps secrets out of review and refuses to invent amounts", () => {
    const plan = planPropertyImport("p", [room({ monthlyRent: null, monthlyUtilities: null, cleaningFee: null, depositHeld: null })]);
    expect(JSON.stringify(plan)).not.toContain("SECRET");
    expect(plan.actions.some(a => a.type === "terms")).toBe(false);
  });
});
