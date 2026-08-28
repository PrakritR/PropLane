/**
 * Planning what the workbook import will create.
 *
 * The instruction that shapes this whole module: every occupant gets an account, and NOBODY is
 * contacted. These are real people who have not agreed to hear from PropLane, and an accidental
 * invitation cannot be recalled — so the first test below is the one that matters most.
 *
 * The second theme is that the sheet is incomplete in places, and the plan must say so rather than
 * fill gaps. An invented rent figure becomes a charge against a real person.
 */
import { describe, expect, it } from "vitest";
import { planPropertyImport, summarisePlan, type PlannedAction } from "@/lib/sales-workbook-import-plan";
import type { RosterRoom } from "@/lib/sales-workbook-roster";

const room = (over: Partial<RosterRoom> = {}): RosterRoom => ({
  room: "Room 1",
  roomNumber: 1,
  occupancy: "resident",
  residentName: "Fekadu Daniel",
  residentPhone: "+14255836477",
  residentEmail: "",
  monthlyRent: 1100,
  monthlyUtilities: 175,
  cleaningFee: null,
  depositHeld: null,
  leaseStartIso: "2026-08-21",
  leaseEndIso: "2026-10-31",
  monthToMonth: false,
  moveInCode: "5223",
  ...over,
});

describe("nobody gets contacted", () => {
  it("plans no action that could send anything", () => {
    // Enforced by the TYPE — `PlannedAction` has no notify variant — so this test is really
    // guarding that nobody widens the type without thinking about it.
    const plan = planPropertyImport("5259-brooklyn", [
      room(),
      room({ room: "Room 2", occupancy: "short-term", residentName: "" }),
    ]);
    const kinds = new Set(plan.actions.map((a) => a.type));
    expect([...kinds].every((k) => ["room", "account", "lease", "charge"].includes(k))).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/notify|invite|email_send|sms|welcome/i);
  });
});

describe("rooms", () => {
  it("creates a record for every room, including empty ones", () => {
    // The portfolio should show the real room count; skipping empties hides the vacancy.
    const plan = planPropertyImport("p", [
      room(),
      room({ room: "Room 2", occupancy: "vacant", residentName: "", residentPhone: "" }),
    ]);
    expect(plan.actions.filter((a) => a.type === "room")).toHaveLength(2);
  });

  it("carries the move-in code onto the room", () => {
    const plan = planPropertyImport("p", [room({ moveInCode: "7528" })]);
    const roomAction = plan.actions.find((a) => a.type === "room") as Extract<PlannedAction, { type: "room" }>;
    expect(roomAction.moveInCode).toBe("7528");
  });

  it("warns rather than inventing a missing move-in code", () => {
    const plan = planPropertyImport("p", [room({ moveInCode: "" })]);
    expect(plan.warnings.some((w) => /move-in code/i.test(w.message))).toBe(true);
  });

  it("creates nothing but a room for a vacant one", () => {
    const plan = planPropertyImport("p", [
      room({ occupancy: "vacant", residentName: "", residentPhone: "", monthlyRent: 825 }),
    ]);
    expect(summarisePlan(plan)).toEqual({ room: 1, account: 0, lease: 0, charge: 0 });
  });
});

describe("short-term occupants", () => {
  const plan = planPropertyImport("p", [room({ occupancy: "short-term", residentName: "" })]);

  it("gets an account, as instructed", () => {
    const account = plan.actions.find((a) => a.type === "account") as Extract<
      PlannedAction,
      { type: "account" }
    >;
    expect(account.occupancy).toBe("short_term");
  });

  it("gets no lease and no rent charges", () => {
    // The sheet records no terms for an Airbnb booking, and manufacturing a tenancy would put a
    // lease in front of someone who never signed one.
    expect(plan.actions.some((a) => a.type === "lease")).toBe(false);
    expect(plan.actions.some((a) => a.type === "charge")).toBe(false);
  });
});

describe("a long-term tenancy", () => {
  it("creates the account, the lease, and the recurring charges", () => {
    const plan = planPropertyImport("p", [room({ depositHeld: 600, cleaningFee: 25 })]);
    expect(summarisePlan(plan)).toEqual({ room: 1, account: 1, lease: 1, charge: 4 });
  });

  it("converts money to cents rather than storing dollars", () => {
    const plan = planPropertyImport("p", [room({ monthlyRent: 1100, monthlyUtilities: 175 })]);
    const charges = plan.actions.filter((a) => a.type === "charge") as Extract<
      PlannedAction,
      { type: "charge" }
    >[];
    expect(charges.find((c) => c.kind === "rent")?.amountCents).toBe(110_000);
    expect(charges.find((c) => c.kind === "utilities")?.amountCents).toBe(17_500);
  });

  it("marks rent and utilities recurring, deposit and move-in fee one-time", () => {
    const plan = planPropertyImport("p", [room({ depositHeld: 600, cleaningFee: 25 })]);
    const charges = plan.actions.filter((a) => a.type === "charge") as Extract<
      PlannedAction,
      { type: "charge" }
    >[];
    expect(charges.find((c) => c.kind === "rent")?.recurring).toBe(true);
    expect(charges.find((c) => c.kind === "utilities")?.recurring).toBe(true);
    expect(charges.find((c) => c.kind === "security_deposit")?.recurring).toBe(false);
    expect(charges.find((c) => c.kind === "move_in_fee")?.recurring).toBe(false);
  });

  it("carries month-to-month onto the lease instead of an end date", () => {
    const plan = planPropertyImport("p", [room({ monthToMonth: true, leaseEndIso: "" })]);
    const lease = plan.actions.find((a) => a.type === "lease") as Extract<PlannedAction, { type: "lease" }>;
    expect(lease.monthToMonth).toBe(true);
    expect(lease.endIso).toBe("");
  });
});

describe("gaps in the sheet", () => {
  it("creates no rent charge when the sheet gave no rent, and says so", () => {
    // Inventing a figure here bills a real person for an amount nobody agreed.
    const plan = planPropertyImport("p", [room({ monthlyRent: null })]);
    expect(plan.actions.some((a) => a.type === "charge" && a.kind === "rent")).toBe(false);
    expect(plan.warnings.some((w) => /no rent amount/i.test(w.message))).toBe(true);
    // The tenancy is still worth recording.
    expect(plan.actions.some((a) => a.type === "lease")).toBe(true);
  });

  it("skips a zero or absent utilities line rather than charging zero", () => {
    for (const utilities of [null, 0]) {
      const plan = planPropertyImport("p", [room({ monthlyUtilities: utilities })]);
      expect(plan.actions.some((a) => a.type === "charge" && a.kind === "utilities")).toBe(false);
    }
  });

  it("warns about a tenancy with no end date and no month-to-month", () => {
    const plan = planPropertyImport("p", [room({ leaseEndIso: "", monthToMonth: false })]);
    expect(plan.warnings.some((w) => /no lease end date/i.test(w.message))).toBe(true);
  });

  it("still creates an account for someone with no contact details, but flags it", () => {
    const plan = planPropertyImport("p", [room({ residentPhone: "", residentEmail: "" })]);
    expect(plan.actions.some((a) => a.type === "account")).toBe(true);
    expect(plan.warnings.some((w) => /no phone or email/i.test(w.message))).toBe(true);
  });

  it("names the property and room on every warning, so it can be acted on", () => {
    const plan = planPropertyImport("5259-brooklyn", [room({ room: "Room 7", moveInCode: "" })]);
    expect(plan.warnings[0]).toMatchObject({ propertyKey: "5259-brooklyn", room: "Room 7" });
  });
});
