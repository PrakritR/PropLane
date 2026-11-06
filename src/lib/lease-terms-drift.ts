import { parseMoneyAmount } from "@/lib/parse-money";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/* ─────────────────────── the sent lease carries the record's terms ─────────────────────── */

type TermsSnapshot = Partial<Pick<RentalWizardFormState, "leaseStart" | "leaseEnd" | "managerRentOverride" | "managerSecurityDepositOverride">> | null | undefined;

/**
 * The terms a lease row carries against the application it was made from. The Send lease screen
 * no longer edits terms; Edit resident does, and its save regenerates the editable lease. So a
 * lease that goes out with different rent, deposit or dates than the record is a stale or
 * tampered body, and the server refuses it. Returns the names of the terms that differ.
 */
export function leaseTermsDriftFromApplication(lease: TermsSnapshot, application: TermsSnapshot): Array<"start" | "end" | "rent" | "deposit"> {
  const money = (v: string | undefined) => {
    const n = parseMoneyAmount(v ?? "");
    return n > 0 ? n : 0;
  };
  const day = (v: string | undefined) => (v ?? "").trim();
  const out: Array<"start" | "end" | "rent" | "deposit"> = [];
  if (day(lease?.leaseStart) !== day(application?.leaseStart)) out.push("start");
  if (day(lease?.leaseEnd) !== day(application?.leaseEnd)) out.push("end");
  if (money(lease?.managerRentOverride) !== money(application?.managerRentOverride)) out.push("rent");
  if (money(lease?.managerSecurityDepositOverride) !== money(application?.managerSecurityDepositOverride)) out.push("deposit");
  return out;
}

/** Rent that is almost certainly a typo: under $100 or more than 5× the house's median room rent. */
export function implausibleRentReason(rent: number, medianRoomRent: number | null): string | null {
  if (!(rent > 0)) return null;
  if (rent < 100) return "under $100 a month";
  if (medianRoomRent && medianRoomRent > 0 && rent > medianRoomRent * 5) return "over 5× the house's median room rent";
  return null;
}

export function medianOf(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
