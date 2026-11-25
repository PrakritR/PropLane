import { describe, it, expect } from "vitest";
import { extensionCurrentEnd, priceStayExtension, validStayDate, extensionCoversRecurring, type ExtensionCharge } from "@/lib/lease-stay-extension";
const base = { currentEnd: "2026-11-30", checkout: "2027-02-01", pricing: { room: { monthlyRent: 1000 }, submission: {}, application: { rentalType: "standard", leaseTerm: "Long-term" } }, monthlyUtilities: 0, fees: [] };
describe("stay extensions", () => {
  it("bills two added full months, with February 1 checkout excluding February", () => {
    const lines = priceStayExtension(base);
    expect(lines.map((l) => [l.start, l.end, l.amountCents])).toEqual([["2026-12-01", "2026-12-31", 100000], ["2027-01-01", "2027-01-31", 100000]]);
    expect(lines.some((l) => /deposit/i.test(l.label))).toBe(false);
  });
  it("prorates both partial boundaries and monthly fees using actual calendar days", () => {
    const lines = priceStayExtension({ ...base, currentEnd: "2026-12-14", checkout: "2027-01-11", monthlyUtilities: 31, fees: [{ id: "custom", label: "Custom dates", amount: 100 }] });
    expect(lines.filter((l) => l.key === "rent").map((l) => l.amountCents)).toEqual([54839, 32258]);
    expect(lines.filter((l) => l.key === "utilities").map((l) => l.amountCents)).toEqual([1700, 1000]);
    expect(lines.filter((l) => l.feeId).map((l) => l.amountCents)).toEqual([5484, 3226]);
  });
  it("retains negotiated rent rather than replacing it with the listing price", () => {
    const lines = priceStayExtension({ ...base, pricing: { ...base.pricing, application: { ...base.pricing.application, managerRentOverride: "875" } } });
    expect(lines.map((l) => l.amountCents)).toEqual([87500, 87500]);
  });
  it("uses the short stay weekly and monthly ladder", () => {
    const pricing = { room: { monthlyRent: 1000, shortTermRent: "50", weeklyRentPrice: 300 }, submission: {}, application: { rentalType: "short_term" } };
    expect(priceStayExtension({ ...base, pricing, checkout: "2026-12-08" })[0]?.amountCents).toBe(30000);
    expect(priceStayExtension({ ...base, pricing, checkout: "2026-12-31" })[0]?.amountCents).toBe(100000);
  });
  it("uses a recorded resident end for an imported lease missing its own end", () => {
    expect(extensionCurrentEnd({ residentEnd: "2026-11-30" })).toBe("2026-11-30");
    expect(extensionCurrentEnd({ bookingEnds: ["2026-11-30", "2026-11-30"] })).toBe("2026-11-30");
    expect(() => extensionCurrentEnd({ residentEnd: "2026-11-30", leaseEnd: "2026-12-01" })).toThrow(/conflicting/);
    expect(() => extensionCurrentEnd({})).toThrow(/missing/);
  });
  it("rejects nonexistent dates and non-extensions", () => {
    expect(validStayDate("2027-02-29")).toBe(false);
    expect(validStayDate("2028-02-29")).toBe(true);
    expect(() => priceStayExtension({ ...base, checkout: "2026-12-01" })).toThrow(/after/);
  });
  it("covers recurring generation only for the same owner, resident, house and period", () => {
    const c = { managerUserId: "owner", residentEmail: "qa@example.invalid", propertyId: "house", status: "paid", stayExtension: { extensionId: "x", key: "rent", start: "2026-12-01", end: "2026-12-31" } } as ExtensionCharge;
    const scope = { managerUserId: "owner", residentEmail: "qa@example.invalid", propertyId: "house", month: "2026-12", key: "rent" };
    expect(extensionCoversRecurring([c], scope)).toBe(true);
    expect(extensionCoversRecurring([c], { ...scope, managerUserId: "other" })).toBe(false);
    expect(extensionCoversRecurring([c], { ...scope, month: "2027-01" })).toBe(false);
    expect(extensionCoversRecurring([{ ...c, status: "void" }], scope)).toBe(false);
  });
});

describe("extension billing coverage", () => {
  it("credits pre-billed future rent but refuses to guess an old partial month's coverage", async () => {
    const { creditPrebilledExtension } = await import("@/lib/lease-stay-extension");
    const lines = priceStayExtension(base);
    const paid = { kind: "rent", status: "paid", rentMonth: "2026-12", amountLabel: "$1,000.00" } as ExtensionCharge;
    expect(creditPrebilledExtension(lines, [paid], base.currentEnd).map((l) => l.amountCents)).toEqual([0, 100000]);
    expect(creditPrebilledExtension(lines, [{ ...paid, status: "void" }], base.currentEnd)[0]?.amountCents).toBe(100000);
    expect(() => creditPrebilledExtension(lines, [paid], "2026-12-14")).toThrow(/no covered dates/);
  });
  it("does not generate recurring rent, utilities or fees over an already charged extension", async () => {
    const { planRecurringRentCharges } = await import("@/lib/recurring-rent-sweep");
    const common = { residentEmail: "qa@example.invalid", residentName: "QA", residentUserId: null, propertyId: "house", propertyLabel: "QA House", roomLabel: "Room 1", managerUserId: "owner" };
    const existing = (["rent", "utilities", "other_cost"] as const).map((kind) => ({ ...common, id: kind, createdAt: "2026-11-24", kind, status: "pending" as const, title: kind, amountLabel: "$100", balanceLabel: "$100", blocksLeaseUntilPaid: false, rentMonth: "2026-12", customFeeId: kind === "other_cost" ? "extension:x:fee:parking" : undefined,
      stayExtension: { extensionId: "x", key: kind === "other_cost" ? "fee:parking" : kind, start: "2026-12-01", end: "2026-12-31" } }));
    const result = planRecurringRentCharges({ now: new Date("2026-12-15T12:00:00Z"), existing, profiles: [{ ...common, id: "profile", monthlyRent: 1000, monthlyUtilities: 30, monthlyFees: [{ id: "parking", label: "Parking", amount: 100 }], dueDay: 1, startMonth: "2026-12", leaseEnd: "2026-12-31", active: true, updatedAt: "2026-11-24" }] });
    expect(result.newCharges).toEqual([]);
  });
});
