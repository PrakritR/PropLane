import { dedupeHouseholdCharges, householdChargeDueDate, type HouseholdCharge } from "@/lib/household-charges";
import { dollarsToCents } from "./money";
import { checkedSum } from "./property-worksheet";
const RENT = new Set(["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent", "stay_total"]);
export function buildRentDueSummary(charges: HouseholdCharge[], period: string) {
  let dueCents = 0, collectedCents = 0;
  const rooms: Record<string, Record<string, { paidCents: number; outstandingCents: number }>> = {};
  const seen = new Set<string>();
  for (const charge of dedupeHouseholdCharges(charges)) {
    if (seen.has(charge.id) || charge.status === "cancelled" || charge.status === "failed") continue;
    seen.add(charge.id);
    const date = householdChargeDueDate(charge);
    const month = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` : charge.rentMonth || "";
    if (!month.startsWith(period)) continue;
    const amount = dollarsToCents(charge.amountLabel);
    const paid = charge.status === "refunded" ? 0 : charge.paidAmountCents ?? (charge.status === "paid" ? amount : 0);
    if (amount < 0 || paid < 0 || paid > amount) throw new Error("Invalid charge amount.");
    checkedSum([amount, paid]);
    if (RENT.has(charge.kind)) { dueCents = checkedSum([dueCents, amount]); collectedCents = checkedSum([collectedCents, paid]); }
    const room = `${charge.propertyLabel} · ${(charge as HouseholdCharge & { roomLabel?: string }).roomLabel || "Unassigned room"}`;
    rooms[room] ??= {}; rooms[room][charge.kind] ??= { paidCents: 0, outstandingCents: 0 };
    const item = rooms[room][charge.kind]; item.paidCents = checkedSum([item.paidCents, paid]); item.outstandingCents = checkedSum([item.outstandingCents, charge.status === "refunded" ? 0 : amount - paid]);
  }
  return { dueCents, collectedCents, percent: dueCents ? Math.round(collectedCents / dueCents * 100) : null, rooms };
}
