/**
 * Pure platform-hold math — no Stripe SDK, no database.
 * Destination charges skip this module. Holds exist only when Connect + bank
 * is not ready; leftover funds move at connect, never on Withdraw.
 */

export const PLATFORM_HOLD_SOURCES = ["household_charge", "application_fee", "vendor_invoice"] as const;
export type PlatformHoldSource = (typeof PLATFORM_HOLD_SOURCES)[number];

export const PLATFORM_HOLD_ROLES = ["manager", "vendor"] as const;
export type PlatformHoldOwnerRole = (typeof PLATFORM_HOLD_ROLES)[number];

export const PLATFORM_HOLD_STATUSES = ["held", "transferred", "refunded"] as const;
export type PlatformHoldStatus = (typeof PLATFORM_HOLD_STATUSES)[number];

export type PlatformHoldRow = {
  id: string;
  ownerUserId: string;
  ownerRole: PlatformHoldOwnerRole;
  source: PlatformHoldSource;
  sourceId: string;
  amountCents: number;
  status: PlatformHoldStatus;
  stripeChargeId: string | null;
  stripeTransferId: string | null;
  createdAt?: string;
};

export function platformHoldCreditKey(source: PlatformHoldSource, sourceId: string): string {
  return `${source}:${sourceId.trim()}`;
}

/** A second credit for the same source id is refused — webhook replay safe. */
export function canCreditPlatformHold(existing: Pick<PlatformHoldRow, "source" | "sourceId"> | null): boolean {
  return existing == null;
}

export function sumHeldCents(rows: ReadonlyArray<Pick<PlatformHoldRow, "amountCents" | "status">>): number {
  return rows.reduce((sum, row) => (row.status === "held" ? sum + Math.max(0, row.amountCents) : sum), 0);
}

export function holdsReadyToTransfer(
  rows: ReadonlyArray<PlatformHoldRow>,
): PlatformHoldRow[] {
  return rows.filter((row) => row.status === "held" && row.amountCents > 0);
}

export function applyHoldTransfer(
  row: PlatformHoldRow,
  stripeTransferId: string,
): PlatformHoldRow {
  return { ...row, status: "transferred", stripeTransferId };
}

export function applyHoldRefund(row: PlatformHoldRow): PlatformHoldRow {
  return { ...row, status: "refunded" };
}

export function availableCentsFromHoldAndStripe(heldCents: number, stripeAvailableCents: number): number {
  return Math.max(0, heldCents) + Math.max(0, stripeAvailableCents);
}

/** Withdraw spends Stripe balance only. A legacy snapshot without hold fields still uses Available. */
export function withdrawableCentsFromSnapshot(opts: {
  availableCents: number;
  withdrawableCents?: number;
  heldCents?: number;
}): number {
  if (typeof opts.withdrawableCents === "number") return Math.max(0, opts.withdrawableCents);
  if ((opts.heldCents ?? 0) > 0) return 0;
  return Math.max(0, opts.availableCents);
}

export function payoutsAvailableNote(opts: {
  ready: boolean;
  heldCents: number;
  bankLabel?: string | null;
}): string {
  if (!opts.ready && opts.heldCents > 0) return "Held on PropLane until a bank is connected";
  if (opts.ready && opts.bankLabel) return `On your Stripe · ${opts.bankLabel}`;
  if (opts.ready) return "On your Stripe";
  return "";
}
