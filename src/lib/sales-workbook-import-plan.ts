/** Roster review only. Rates are terms; they are not evidence of an unpaid balance. */
import type { RosterRoom } from "@/lib/sales-workbook-roster";
export type PlannedAction =
  | { type: "room"; propertyKey: string; room: string; monthlyRentCents: number | null }
  | { type: "account"; propertyKey: string; room: string; name: string; phone: string; email: string; occupancy: "resident" | "short_term"; ready: boolean }
  | { type: "lease"; propertyKey: string; room: string; residentName: string; startIso: string; endIso: string; monthToMonth: boolean; ready: boolean }
  | { type: "terms"; propertyKey: string; room: string; kind: "rent" | "utilities" | "move_in_fee"; amountCents: number; recurring: boolean }
  | { type: "held_deposit"; propertyKey: string; room: string; amountCents: number; requiresReceiptDate: true };
export type ImportPlan = { actions: PlannedAction[]; warnings: { propertyKey: string; room: string; message: string }[] };
const cents = (amount: number | null) => amount != null && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
export function planPropertyImport(propertyKey: string, rooms: readonly RosterRoom[]): ImportPlan {
  const actions: PlannedAction[] = [];
  const warnings: ImportPlan["warnings"] = [];
  for (const room of rooms) {
    const base = { propertyKey, room: room.room };
    const warn = (message: string) => warnings.push({ ...base, message });
    actions.push({ ...base, type: "room", monthlyRentCents: cents(room.monthlyRent) });
    if (room.occupancy === "vacant") continue;
    const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(room.residentEmail);
    actions.push({ ...base, type: "account", name: room.residentName, phone: room.residentPhone, email: room.residentEmail, occupancy: room.occupancy === "short-term" ? "short_term" : "resident", ready: emailReady });
    if (!emailReady) warn("Account needs a verified identity mapping and valid email; no placeholder email will be created.");
    if (room.occupancy === "short-term") { warn("Short-term occupancy needs dated booking evidence; no lease or resident debt is inferred."); continue; }
    const ready = Boolean(room.leaseStartIso && (room.leaseEndIso || room.monthToMonth));
    actions.push({ ...base, type: "lease", residentName: room.residentName, startIso: room.leaseStartIso, endIso: room.leaseEndIso, monthToMonth: room.monthToMonth, ready });
    if (!ready) warn("Confirm lease start and end date or month-to-month status before creating terms.");
    for (const [kind, amount, recurring] of [["rent", room.monthlyRent, true], ["utilities", room.monthlyUtilities, true], ["move_in_fee", room.cleaningFee, false]] as const) {
      const amountCents = cents(amount);
      if (amountCents != null && amountCents > 0) actions.push({ ...base, type: "terms", kind, amountCents, recurring });
    }
    const held = cents(room.depositHeld);
    if (held != null && held > 0) {
      actions.push({ ...base, type: "held_deposit", amountCents: held, requiresReceiptDate: true });
      warn("Deposit is already held, not owed. Confirm receipt date and any prior refunds/deductions.");
    }
    if (cents(room.monthlyRent) == null) warn("No rent amount in the sheet.");
  }
  return { actions, warnings };
}
export function summarisePlan(plan: ImportPlan): Record<PlannedAction["type"], number> {
  const counts = { room: 0, account: 0, lease: 0, terms: 0, held_deposit: 0 };
  for (const action of plan.actions) counts[action.type]++;
  return counts;
}
