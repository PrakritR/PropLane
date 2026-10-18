import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  buildMorningDigestText,
  digestIsEmpty,
  monthLabel,
  pacificClock,
  resolveDayKey,
  resolveMonthKey,
  shiftDayKey,
  summarizeRentForMonth,
  usd,
  whichHouseQuestion,
} from "@/lib/one-number/ops-text";
import { isGsm7, smsSegmentCount } from "@/lib/one-number/segments";

function charge(over: Partial<HouseholdCharge>): HouseholdCharge {
  return {
    id: over.id ?? "c1",
    createdAt: "2026-10-01T00:00:00Z",
    residentEmail: "a@x.test",
    residentName: "Ana",
    residentUserId: null,
    propertyId: "p1",
    propertyLabel: "5259 Brooklyn",
    managerUserId: "m1",
    kind: "rent",
    title: "October rent",
    amountLabel: "$900.00",
    balanceLabel: "$900.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    rentMonth: "2026-10",
    ...over,
  } as HouseholdCharge;
}

describe("days", () => {
  const now = new Date("2026-10-18T19:00:00Z"); // 12:00 Pacific, Oct 18
  it("resolves today, tomorrow and a real date in Pacific time", () => {
    expect(resolveDayKey("today", now)).toBe("2026-10-18");
    expect(resolveDayKey("Tomorrow", now)).toBe("2026-10-19");
    expect(resolveDayKey("2026-11-01", now)).toBe("2026-11-01");
  });
  it("refuses a made-up date and any other word", () => {
    expect(resolveDayKey("2026-02-30", now)).toBeNull();
    expect(resolveDayKey("next tuesday", now)).toBeNull();
  });
  it("uses the Pacific day, not the UTC day, late in the evening", () => {
    // 02:00 UTC on Oct 19 is still Oct 18 in Pacific.
    expect(resolveDayKey("today", new Date("2026-10-19T02:00:00Z"))).toBe("2026-10-18");
  });
  it("shifts across a month and a DST change without drifting", () => {
    expect(shiftDayKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDayKey("2026-11-01", 1)).toBe("2026-11-02");
  });
  it("formats a Pacific clock time", () => {
    expect(pacificClock("2026-10-19T17:30:00Z")).toBe("10:30 am");
    expect(pacificClock("2026-10-19T22:00:00Z")).toBe("3:00 pm");
    expect(pacificClock("nope")).toBe("");
  });
  it("resolves months", () => {
    expect(resolveMonthKey(undefined, now)).toBe("2026-10");
    expect(resolveMonthKey("2026-09")).toBe("2026-09");
    expect(resolveMonthKey("2026-13")).toBeNull();
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
});

describe("rent status", () => {
  it("counts paid and unpaid residents with the balance owed", () => {
    const status = summarizeRentForMonth(
      [
        charge({ id: "1", residentEmail: "a@x.test", residentName: "Ana", status: "paid" }),
        charge({ id: "2", residentEmail: "b@x.test", residentName: "Ben", status: "pending", balanceLabel: "$850.00", amountLabel: "$850.00" }),
        charge({ id: "3", residentEmail: "c@x.test", residentName: "Cy", status: "partially_paid", balanceLabel: "$300.00" }),
      ],
      "2026-10",
    );
    expect(status.paidCount).toBe(1);
    expect(status.unpaidCount).toBe(2);
    expect(status.unpaidCents).toBe(115_000);
    expect(status.unpaid.map((l) => l.residentName)).toEqual(["Ben", "Cy"]);
  });
  it("ignores other months, other kinds, and waived or refunded charges", () => {
    const status = summarizeRentForMonth(
      [
        charge({ id: "1", rentMonth: "2026-09", status: "pending" }),
        charge({ id: "2", kind: "security_deposit", status: "pending" }),
        charge({ id: "3", status: "cancelled" }),
        charge({ id: "4", status: "refunded" }),
      ],
      "2026-10",
    );
    expect(status).toMatchObject({ paidCount: 0, unpaidCount: 0, unpaidCents: 0, unpaid: [] });
  });
  it("treats a resident with two rent lines as unpaid while either is open, and counts them once", () => {
    const status = summarizeRentForMonth(
      [
        charge({ id: "1", kind: "first_month_rent", status: "paid" }),
        charge({ id: "2", kind: "rent", status: "pending", balanceLabel: "$200.00" }),
      ],
      "2026-10",
    );
    expect(status.paidCount).toBe(0);
    expect(status.unpaidCount).toBe(1);
    expect(status.unpaidCents).toBe(20_000);
  });
  it("counts an ACH in flight as not yet paid", () => {
    expect(summarizeRentForMonth([charge({ status: "processing" })], "2026-10").unpaidCount).toBe(1);
  });
  it("formats dollars", () => {
    expect(usd(285_000)).toBe("$2,850");
    expect(usd(1250)).toBe("$12.50");
  });
});

describe("the 8am digest text", () => {
  const full = { toursToday: 2, openServices: 3, rent: { paidCount: 14, unpaidCount: 3, unpaidCents: 285_000 }, newLeads: 2 };
  it("carries tours, services, rent paid and unpaid with the amount, and leads", () => {
    expect(buildMorningDigestText(full)).toBe("2 tours today, 3 open services, rent 14 paid, 3 unpaid ($2,850), 2 new leads.");
  });
  it("singularizes and drops clauses with nothing in them", () => {
    expect(buildMorningDigestText({ toursToday: 1, openServices: 0, rent: null, newLeads: 0 })).toBe("1 tour today.");
    expect(buildMorningDigestText({ toursToday: 0, openServices: 1, rent: { paidCount: 5, unpaidCount: 0, unpaidCents: 0 }, newLeads: 1 })).toBe(
      "1 open service, rent all paid (5), 1 new lead.",
    );
  });
  it("is one GSM-7 segment even with the subject line and the teammate prefix", () => {
    const text = buildMorningDigestText(full);
    const sent = `PropLane: Good morning\n${text}`;
    expect(isGsm7(sent)).toBe(true);
    expect(smsSegmentCount(sent)).toBe(1);
  });
  it("is empty when there is nothing to say, so nothing is sent", () => {
    expect(digestIsEmpty({ toursToday: 0, openServices: 0, rent: null, newLeads: 0 })).toBe(true);
    expect(digestIsEmpty({ toursToday: 0, openServices: 0, rent: { paidCount: 0, unpaidCount: 0, unpaidCents: 0 }, newLeads: 0 })).toBe(true);
    expect(digestIsEmpty({ ...full, toursToday: 0, openServices: 0, newLeads: 0 })).toBe(false);
  });
});

describe("which house", () => {
  it("asks the multi-house question and stays silent for one house", () => {
    expect(whichHouseQuestion(["4709A 8th Ave", "5259 Brooklyn", "5257 Brooklyn"])).toBe("Which house: 4709A 8th Ave, 5259 Brooklyn, 5257 Brooklyn, or all?");
    expect(whichHouseQuestion(["A", "B"])).toBe("Which house: A, B, or all?");
    expect(whichHouseQuestion(["Only"])).toBe("");
  });
});
