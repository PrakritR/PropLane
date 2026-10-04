/**
 * The charges a resident pays BEFORE signing their lease, and the rule that signing waits for them.
 *
 * Captain, 2026-10-03: the lease fee, the deposit, the move-in fee, the first month's rent (when the
 * listing says it is due at signing) and the one-time fees are collected in ONE Stripe payment, and
 * the Sign action stays off until that payment has succeeded.
 *
 * Everything here is a pure function over charge rows so the browser (what the resident sees), the
 * lease route (what the server refuses) and the tests read ONE rule:
 *
 *  - A charge is "at signing" when it was stamped `dueAtSigning` at creation. The stamp is decided
 *    once, from the listing's per-lease-type payment-at-signing ticks, by
 *    {@link chargeKindDueAtSigning}; the lease fee is always at signing.
 *  - A line still blocks signing while it is not `paid` / `cancelled` / `refunded`. A bank transfer that
 *    is still `processing` has not succeeded and keeps blocking: only the Stripe webhook (or its
 *    server-side verify) writes `paid`, a client claim never does.
 *  - A WAIVED lease fee is a `cancelled` charge (or never created), so it is neither charged nor part of
 *    the total.
 */
import type { HouseholdCharge, HouseholdChargeKind } from "@/lib/household-charges";
import {
  isPaymentDueAtSigning,
  PAYMENT_AT_SIGNING_FEE_KEY_PREFIX,
  PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX,
} from "@/lib/listing-fee-scope";
import { parseMoneyAmount } from "@/lib/parse-money";
import { ROOM_LEASE_FEE_ID_PREFIX } from "@/lib/room-term-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** What a resident is told when they try to sign with money still owed. Same words on the page and from the route. */
export const AT_SIGNING_UNPAID_MESSAGE =
  "Pay your lease fee and move-in costs first. Signing unlocks as soon as the payment goes through.";
export const AT_SIGNING_UNPAID_CODE = "AT_SIGNING_UNPAID";

const SETTLED_STATUSES: ReadonlySet<HouseholdCharge["status"]> = new Set(["paid", "cancelled", "refunded"]);

/* ------------------------------ the lease fee itself ------------------------------ */

/**
 * The lease fee, in dollars, for the placement `sub` was overlaid for (`submissionWithApplicationRoomFees`).
 * The overlay writes the fee as a one-time `room_lease_fee:<room>` row from the ONE placement resolver
 * (`listing-placement-standard-fees.ts`), so the quote, the lease document, the billing snapshot and the
 * charge all read the same figure. 0 when the placement has no lease fee.
 */
export function leaseFeeDollarsFromOverlaidSubmission(
  sub: Pick<ManagerListingSubmissionV1, "customFees"> | null | undefined,
): number {
  const row = (sub?.customFees ?? []).find((fee) => fee.id.startsWith(ROOM_LEASE_FEE_ID_PREFIX));
  if (!row) return 0;
  const dollars = parseMoneyAmount(row.amount ?? "");
  return dollars > 0 ? Math.round(dollars * 100) / 100 : 0;
}

/** True for the overlay's lease-fee row, which is billed as a `lease_fee` charge and never as a generic one-time fee. */
export function isRoomLeaseFeeRowId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(ROOM_LEASE_FEE_ID_PREFIX);
}

/* ------------------------------------ waiver ------------------------------------ */

/** Who waived a lease fee, when and why. Stored on the application the manager owns and on the cancelled charge. */
export type LeaseFeeWaiver = {
  waivedAtIso: string;
  waivedByUserId: string;
  reason: string;
};

export function readLeaseFeeWaiver(
  application: { managerLeaseFeeWaiver?: unknown } | null | undefined,
): LeaseFeeWaiver | null {
  const raw = application?.managerLeaseFeeWaiver;
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<LeaseFeeWaiver>;
  if (typeof w.waivedAtIso !== "string" || !w.waivedAtIso.trim()) return null;
  return {
    waivedAtIso: w.waivedAtIso,
    waivedByUserId: typeof w.waivedByUserId === "string" ? w.waivedByUserId : "",
    reason: typeof w.reason === "string" ? w.reason : "",
  };
}

/* ------------------------- which charges are due at signing ------------------------- */

/**
 * Is a charge of `kind` collected at signing on this lease type? The listing's per-lease-type ticks decide
 * (the same `isPaymentDueAtSigning` the quote uses), a custom one-time fee by its own tick; the lease fee is
 * always collected then. With no listing the legacy set
 * (deposit + move-in) applies.
 */
export function chargeKindDueAtSigning(
  kind: HouseholdChargeKind,
  ctx: {
    sub: Parameters<typeof isPaymentDueAtSigning>[0] | null | undefined;
    leaseTerm: string | null | undefined;
    roomId: string | null | undefined;
    /** A recurring-month charge (carries a rentMonth) is never an at-signing line. */
    hasRentMonth?: boolean;
    /** The listing fee row a one-time `other_cost` charge bills: it follows that fee's own tick. */
    customFeeId?: string | null;
  },
): boolean {
  if (ctx.hasRentMonth) return false;
  if (kind === "lease_fee") return true;
  if (kind === "other_cost") {
    // A custom one-time fee is collected at signing only when the manager ticked it, exactly as the
    // preview shows; unticked, it is a normal one-time charge. The manager's own per-application
    // other cost (no fee row) and the legacy lease-fee line are always collected then.
    const feeId = ctx.customFeeId?.trim();
    if (!feeId || !ctx.sub || isRoomLeaseFeeRowId(feeId)) return true;
    return isPaymentDueAtSigning(ctx.sub, `${PAYMENT_AT_SIGNING_FEE_KEY_PREFIX}${feeId}`, ctx.leaseTerm, ctx.roomId);
  }
  const { sub, leaseTerm, roomId } = ctx;
  const due = (key: string) => (sub ? isPaymentDueAtSigning(sub, key, leaseTerm, roomId) : false);
  switch (kind) {
    case "security_deposit":
      return sub ? due("security_deposit") : true;
    case "move_in_fee":
      return sub ? due("move_in_fee") : true;
    case "first_month_rent":
    case "prorated_rent":
    case "stay_total":
    case "prorated_fee": {
      if (!sub) return false;
      const rentKey = roomId ? `${PAYMENT_AT_SIGNING_ROOM_RENT_KEY_PREFIX}${roomId}` : "first_month_rent";
      return due(rentKey) || (Boolean(roomId) && due("first_month_rent"));
    }
    case "utilities":
    case "prorated_utilities":
      return due("first_month_utilities");
    default:
      return false;
  }
}

/* --------------------------- the gate, over a charge list --------------------------- */

export function isAtSigningCharge(charge: Pick<HouseholdCharge, "dueAtSigning">): boolean {
  return charge.dueAtSigning === true;
}

/** An at-signing line the resident still has to pay (a waived/cancelled, paid or refunded one is not). */
export function isUnpaidAtSigningCharge(charge: Pick<HouseholdCharge, "dueAtSigning" | "status">): boolean {
  return isAtSigningCharge(charge) && !SETTLED_STATUSES.has(charge.status);
}

export function atSigningLineCents(charge: Pick<HouseholdCharge, "balanceLabel" | "amountLabel">): number {
  const raw = charge.balanceLabel?.trim() || charge.amountLabel?.trim() || "";
  const dollars = parseMoneyAmount(raw);
  return dollars > 0 ? Math.round(dollars * 100) : 0;
}

export function unpaidAtSigningCharges<T extends Pick<HouseholdCharge, "dueAtSigning" | "status">>(
  charges: readonly T[],
): T[] {
  return charges.filter(isUnpaidAtSigningCharge);
}

/** The exact total of the lines still owed. It is the sum of the charges, never a separately computed figure. */
export function atSigningTotalCents(
  charges: readonly Pick<HouseholdCharge, "dueAtSigning" | "status" | "balanceLabel" | "amountLabel">[],
): number {
  return unpaidAtSigningCharges(charges).reduce((sum, charge) => sum + atSigningLineCents(charge), 0);
}

/** May the resident sign? Only once no at-signing line is unpaid. */
export function atSigningAllowsSignature(charges: readonly Pick<HouseholdCharge, "dueAtSigning" | "status">[]): boolean {
  return unpaidAtSigningCharges(charges).length === 0;
}

/** Narrow a charge list to one lease: its application(s), else the resident + property it was sent for. */
export function chargesForLeaseSigning<
  T extends Pick<HouseholdCharge, "applicationId" | "residentEmail" | "propertyId">,
>(
  charges: readonly T[],
  lease: {
    applicationIds: readonly string[];
    residentEmails: readonly string[];
    propertyId?: string | null;
  },
  normalizeId: (id: string) => string = (id) => id.trim().toUpperCase(),
): T[] {
  const apps = new Set(lease.applicationIds.map((id) => normalizeId(id)).filter(Boolean));
  const emails = new Set(lease.residentEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const propertyId = lease.propertyId?.trim() ?? "";
  return charges.filter((charge) => {
    const appId = charge.applicationId?.trim();
    if (appId && apps.size > 0) return apps.has(normalizeId(appId));
    if (!emails.has(charge.residentEmail.trim().toLowerCase())) return false;
    return !propertyId || charge.propertyId?.trim() === propertyId;
  });
}
