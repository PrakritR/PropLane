/**
 * The hold fee: a deposit that reserves a room for a fixed window. Pure decisions only (no IO), shared by the
 * manager and resident views, the credit-at-approval path and the expiry sweep, so none can drift.
 *
 *  - Default $100, valid 7 days, used when the listing's holding fee is blank (never written to a listing).
 *  - The window runs from the PAID time, not the request time.
 *  - A lease signed inside the window credits the hold toward the security deposit (existing path).
 *  - A hold that runs out is marked expired and the room is released; the money is NEVER auto-refunded.
 */
import { parseMoneyAmount } from "@/lib/parse-money";

export const DEFAULT_HOLD_FEE_CENTS = 10_000;
export const HOLD_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

type HoldCharge = {
  kind?: string;
  status?: string;
  paidAt?: string;
  holdExpiresAt?: string;
  holdExpiredAt?: string;
};

/** The listing's holding fee in cents, or the $100 default when it is blank / zero / unreadable. */
export function resolveHoldFeeCents(listingHoldingFee: string | number | null | undefined): number {
  const raw = typeof listingHoldingFee === "number" ? listingHoldingFee : parseMoneyAmount(String(listingHoldingFee ?? ""));
  const cents = Math.round((Number.isFinite(raw) ? raw : 0) * 100);
  return cents > 0 ? cents : DEFAULT_HOLD_FEE_CENTS;
}

/** paid time + 7 days, as ISO, or null when the paid time is not a real date. */
export function holdExpiresAtFor(paidAtIso: string | null | undefined): string | null {
  const paid = Date.parse(paidAtIso ?? "");
  if (!Number.isFinite(paid)) return null;
  return new Date(paid + HOLD_WINDOW_DAYS * DAY_MS).toISOString();
}

/** The stored deadline, else one derived from the paid time (rows written before the stamp existed). */
export function effectiveHoldExpiresAt(charge: HoldCharge): string | null {
  if (charge.kind !== "holding_deposit") return null;
  const stored = Date.parse(charge.holdExpiresAt ?? "");
  if (Number.isFinite(stored)) return new Date(stored).toISOString();
  return charge.status === "paid" ? holdExpiresAtFor(charge.paidAt) : null;
}

export type HoldState = "none" | "active" | "expired";

export function holdState(charge: HoldCharge, now: Date = new Date()): HoldState {
  if (charge.kind !== "holding_deposit" || charge.status !== "paid") return "none";
  if (charge.holdExpiredAt) return "expired";
  const expires = effectiveHoldExpiresAt(charge);
  if (!expires) return "none";
  return now.getTime() >= Date.parse(expires) ? "expired" : "active";
}

/** Short label for a hold row: "Hold expires Nov 21" / "Hold expired Nov 21". Null when it is not a paid hold. */
export function holdDeadlineLabel(charge: HoldCharge, now: Date = new Date()): string | null {
  const state = holdState(charge, now);
  if (state === "none") return null;
  const expires = effectiveHoldExpiresAt(charge);
  if (!expires) return null;
  const when = new Date(expires).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return state === "expired" ? `Hold expired ${when}` : `Hold expires ${when}`;
}

/**
 * What a hold credits toward the security deposit when the lease is signed: the whole hold, never more than the
 * deposit, and nothing once it has expired (an expired hold is kept per policy, not applied).
 */
export function holdCreditCents(charge: HoldCharge & { amountLabel?: string }, depositCents: number, now: Date = new Date()): number {
  if (charge.kind !== "holding_deposit") return 0;
  if (charge.status === "pending") return Math.min(Math.round(parseMoneyAmount(charge.amountLabel ?? "") * 100), Math.max(0, depositCents));
  if (charge.status !== "paid" || holdState(charge, now) === "expired") return 0;
  return Math.min(Math.round(parseMoneyAmount(charge.amountLabel ?? "") * 100), Math.max(0, depositCents));
}
