/**
 * Turning a parsed workbook roster into the exact records to create.
 *
 * This plans; it does not write. Keeping the decision separate from the execution is what makes a
 * dry run meaningful — the plan can be printed and read in full before anything reaches a
 * database, which matters when the target is a live site holding real tenancies.
 *
 * **Nothing here can send anything.** The captain's instruction was that every occupant gets an
 * account but receives no email, SMS, or invitation. That is enforced structurally rather than by
 * discipline: `PlannedAction` has no notify variant, so a send is not expressible in a plan, and
 * an executor that only consumes plans has nothing to act on. If a send is ever wanted it has to
 * be added to this type deliberately, in a diff someone reads.
 *
 * The other rule is inherited from the parser: a value the sheet did not plainly state is left
 * out rather than guessed. A rent figure invented here becomes a charge against a real person.
 */
import type { RosterRoom } from "@/lib/sales-workbook-roster";

/** Every kind of record the import may create. Deliberately no `notify` — see the file comment. */
export type PlannedAction =
  | { type: "room"; propertyKey: string; room: string; moveInCode: string; monthlyRentCents: number | null }
  | {
      type: "account";
      propertyKey: string;
      room: string;
      name: string;
      phone: string;
      email: string;
      /** `resident` for a long-term tenant, `short_term` for an Airbnb occupant. */
      occupancy: "resident" | "short_term";
    }
  | {
      type: "lease";
      propertyKey: string;
      room: string;
      residentName: string;
      startIso: string;
      endIso: string;
      monthToMonth: boolean;
    }
  | {
      type: "charge";
      propertyKey: string;
      room: string;
      residentName: string;
      kind: "rent" | "utilities" | "security_deposit" | "move_in_fee";
      amountCents: number;
      /** True for a charge that repeats monthly, false for a one-time amount. */
      recurring: boolean;
    };

export type ImportPlan = {
  actions: PlannedAction[];
  /** Things a human must look at. Never silently dropped. */
  warnings: { propertyKey: string; room: string; message: string }[];
};

const toCents = (amount: number | null): number | null =>
  amount == null ? null : Math.round(amount * 100);

/**
 * Plan one property tab.
 *
 * Every room becomes a room record — including the empty ones — so the portfolio shows the real
 * room count and the vacancy picture is honest. An occupied room additionally gets an account,
 * and a long-term tenancy gets a lease and its recurring charges.
 *
 * A short-term (Airbnb) occupant gets an account but NO lease or rent charges: the sheet records
 * no terms for them, and inventing a tenancy for someone booked through another platform would
 * put a lease in front of a person who never signed one.
 */
export function planPropertyImport(propertyKey: string, rooms: readonly RosterRoom[]): ImportPlan {
  const actions: PlannedAction[] = [];
  const warnings: ImportPlan["warnings"] = [];
  const warn = (room: string, message: string) => warnings.push({ propertyKey, room, message });

  for (const room of rooms) {
    const rentCents = toCents(room.monthlyRent);

    actions.push({
      type: "room",
      propertyKey,
      room: room.room,
      moveInCode: room.moveInCode,
      monthlyRentCents: rentCents,
    });

    if (!room.moveInCode) {
      // The code is what gets a resident through the door; its absence is a gap someone has to
      // fill by hand, not something to fabricate.
      warn(room.room, "No move-in code in the sheet.");
    }

    if (room.occupancy === "vacant") {
      continue;
    }

    actions.push({
      type: "account",
      propertyKey,
      room: room.room,
      name: room.residentName,
      phone: room.residentPhone,
      email: room.residentEmail,
      occupancy: room.occupancy === "short-term" ? "short_term" : "resident",
    });

    if (room.occupancy === "short-term") {
      // No lease, no rent: the sheet records no terms for a short-term booking.
      continue;
    }

    if (!room.residentPhone && !room.residentEmail) {
      // Not fatal — the account is still worth creating — but nobody can be contacted later.
      warn(room.room, `${room.residentName} has no phone or email in the sheet.`);
    }

    actions.push({
      type: "lease",
      propertyKey,
      room: room.room,
      residentName: room.residentName,
      startIso: room.leaseStartIso,
      endIso: room.leaseEndIso,
      monthToMonth: room.monthToMonth,
    });

    if (!room.leaseEndIso && !room.monthToMonth) {
      warn(room.room, `${room.residentName} has no lease end date and is not marked month-to-month.`);
    }

    if (rentCents == null) {
      // A tenancy with no rent is a real gap in the source, and inventing one bills someone.
      warn(room.room, `${room.residentName} has no rent amount in the sheet.`);
    } else {
      actions.push({
        type: "charge",
        propertyKey,
        room: room.room,
        residentName: room.residentName,
        kind: "rent",
        amountCents: rentCents,
        recurring: true,
      });
    }

    const utilitiesCents = toCents(room.monthlyUtilities);
    if (utilitiesCents != null && utilitiesCents > 0) {
      actions.push({
        type: "charge",
        propertyKey,
        room: room.room,
        residentName: room.residentName,
        kind: "utilities",
        amountCents: utilitiesCents,
        recurring: true,
      });
    }

    const depositCents = toCents(room.depositHeld);
    if (depositCents != null && depositCents > 0) {
      // One-time, and a liability rather than income — see `docs/agents/financials.md`.
      actions.push({
        type: "charge",
        propertyKey,
        room: room.room,
        residentName: room.residentName,
        kind: "security_deposit",
        amountCents: depositCents,
        recurring: false,
      });
    }

    const moveInCents = toCents(room.cleaningFee);
    if (moveInCents != null && moveInCents > 0) {
      actions.push({
        type: "charge",
        propertyKey,
        room: room.room,
        residentName: room.residentName,
        kind: "move_in_fee",
        amountCents: moveInCents,
        recurring: false,
      });
    }
  }

  return { actions, warnings };
}

/** A one-line-per-kind summary, for printing a dry run before anyone approves it. */
export function summarisePlan(plan: ImportPlan): Record<PlannedAction["type"], number> {
  const counts: Record<PlannedAction["type"], number> = { room: 0, account: 0, lease: 0, charge: 0 };
  for (const action of plan.actions) counts[action.type] += 1;
  return counts;
}
