import { resolveStayPricing, resolveRoomProrationForSlot, weeklyRentForBillableDays, type StayPricingInput } from "@/lib/room-pricing";
import { computeProratedFirstMonthTotals } from "@/lib/lease-first-period-proration";
import { shortTermStayTotalAmount } from "@/lib/short-term-stay-pricing";
import type { HouseholdCharge } from "@/lib/household-charges";
import { parseMoneyAmount } from "@/lib/parse-money";

export function validStayDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function stayDatePlus(value: string, days: number): string {
  if (!validStayDate(value)) throw new Error("A valid stay date is required.");
  return new Date(Date.parse(`${value}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
/** Dates here are final occupied nights; checkout is always the following day. */
export function extensionCurrentEnd(input: { residentEnd?: string; leaseEnd?: string; bookingEnds?: string[] }): string {
  const dates = [input.residentEnd, input.leaseEnd].filter((s): s is string => Boolean(s));
  if (!dates.length) dates.push(...(input.bookingEnds ?? []));
  if (!dates.length || dates.some((date) => !validStayDate(date)) || new Set(dates).size !== 1) {
    throw new Error("The current checkout date is missing or conflicting. Correct the resident's stay dates first.");
  }
  return dates[0]!;
}
export type ExtensionLine = { key: string; label: string; month: string; start: string; end: string; amountCents: number; kind: "rent" | "utilities" | "other_cost"; feeId?: string };
export type ExtensionCoverage = { start: string; end: string; key: string; extensionId: string };
export type ExtensionCharge = HouseholdCharge & { stayExtension?: ExtensionCoverage };

/** Credit amounts already billed beyond the old end, without altering paid/waived rows. */
export function creditPrebilledExtension(lines: ExtensionLine[], charges: readonly ExtensionCharge[], oldEnd: string): ExtensionLine[] {
  return lines.map((line) => {
    const billed = charges.filter((c) => c.status !== "void" && c.status !== "refunded" && c.rentMonth === line.month &&
      (line.key === "rent" ? c.kind === "rent" : line.key === "utilities" ? c.kind === "utilities" : c.customFeeId === line.feeId));
    // A prior extension's explicit period cannot cover newly added nights.
    const unbounded = billed.filter((c) => !c.stayExtension);
    if (!unbounded.length) return { ...line };
    const chargedCents = unbounded.reduce((sum, c) => sum + Math.round(parseMoneyAmount(c.amountLabel) * 100), 0);
    if (oldEnd.slice(0, 7) === line.month) throw new Error(`The existing ${line.month} charge has no covered dates. Review its billed period before extending; its receipt has not been changed.`);
    const credit = chargedCents;
    return { ...line, amountCents: Math.max(0, line.amountCents - credit) };
  });
}

export function extensionCoversRecurring(charges: readonly HouseholdCharge[], input: { managerUserId: string | null; residentEmail: string; propertyId: string; month: string; key: string }): boolean {
  return charges.some((raw) => {
    const c = raw as ExtensionCharge;
    return c.status !== "void" && c.status !== "refunded" && c.managerUserId === input.managerUserId &&
      c.residentEmail.toLowerCase() === input.residentEmail.toLowerCase() && c.propertyId === input.propertyId &&
      c.stayExtension?.key === input.key && c.stayExtension.start.slice(0, 7) <= input.month && c.stayExtension.end.slice(0, 7) >= input.month;
  });
}
/** Only the added interval is priced. Never regenerates a deposit or changes an old receipt. */
export function priceStayExtension(input: {
  currentEnd: string; checkout: string; pricing: StayPricingInput; monthlyUtilities: number;
  monthlyFoldIn?: number; fees: { id: string; label: string; amount: number }[];
}): ExtensionLine[] {
  const start = stayDatePlus(input.currentEnd, 1);
  if (!validStayDate(input.checkout) || input.checkout <= start) throw new Error("Choose a checkout date after the current checkout.");
  const end = stayDatePlus(input.checkout, -1);
  if (Date.parse(input.checkout) - Date.parse(start) > 366 * 3 * 86400000) throw new Error("Extend by no more than three years at a time.");
  const application = { ...input.pricing.application, leaseStart: input.pricing.application?.leaseStart || start, leaseEnd: end };
  const pricing = resolveStayPricing({ ...input.pricing, application });
  const result: ExtensionLine[] = [];
  const add = (key: string, label: string, month: string, from: string, to: string, amount: number, kind: ExtensionLine["kind"], feeId?: string) => {
    const amountCents = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error("Could not verify extension pricing.");
    if (amountCents > 0) result.push({ key, label, month, start: from, end: to, amountCents, kind, ...(feeId ? { feeId } : {}) });
  };
  if (pricing.stayKind === "short") {
    const nights = (Date.parse(input.checkout) - Date.parse(start)) / 86400000;
    const amount = shortTermStayTotalAmount(pricing.dailyRate ?? 0, nights, pricing.weeklyRate, pricing.monthlyRate);
    if (!(amount > 0)) throw new Error("Could not verify extension pricing.");
    add("rent", `Added stay · ${nights} nights`, start.slice(0, 7), start, end, amount, "rent");
    return result;
  }
  if (!(Number(pricing.monthlyRate) > 0 || Number(pricing.dailyRate) > 0 || Number(pricing.weeklyRate) > 0)) throw new Error("Could not verify extension pricing.");
  const prorate = resolveRoomProrationForSlot(input.pricing.room, application.residentSlot, application.leaseTerm);
  for (let from = start; from <= end;) {
    const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const to = end < last ? end : last;
    const dim = Number(last.slice(8)), days = Number(to.slice(8)) - Number(from.slice(8)) + 1;
    const partial = days !== dim;
    const fraction = days / dim;
    const totals = computeProratedFirstMonthTotals({ monthlyRent: pricing.monthlyRate ?? 0, monthlyUtilities: input.monthlyUtilities, leaseStart: from, leaseEnd: to, method: prorate.method, dailyRentRate: prorate.dailyRentRate, dailyUtilitiesRate: prorate.dailyUtilitiesRate });
    const rent = pricing.basis === "daily" ? (pricing.dailyRate ?? 0) * days
      : pricing.basis === "weekly" ? weeklyRentForBillableDays(pricing.weeklyRate ?? 0, days)
      : partial ? totals.proratedRent : pricing.monthlyRate ?? 0;
    const month = from.slice(0, 7);
    add("rent", `Rent · ${from}–${to}`, month, from, to, rent + (input.monthlyFoldIn ?? 0) * fraction, "rent");
    add("utilities", `Utilities · ${from}–${to}`, month, from, to, partial ? totals.proratedUtilities : input.monthlyUtilities, "utilities");
    for (const fee of input.fees) add(`fee:${fee.id}`, `${fee.label} · ${from}–${to}`, month, from, to, fee.amount * fraction, "other_cost", fee.id);
    from = stayDatePlus(to, 1);
  }
  return result;
}
