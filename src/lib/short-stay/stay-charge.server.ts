import "server-only";

/**
 * The charge a confirmed guest-portal stay raises: one `stay_total` in the guest's Payments, written
 * through `upsertManagerCharges` so the ledger and the GL entries follow (docs/agents/financials.md).
 *
 * Idempotent on the block id: the charge id is derived from it, a second call (a double-clicked
 * Approve, an instant confirm that also passes through the host's Approve) finds the row and writes
 * nothing, so a paid or part-paid charge is never overwritten. The `hc_mgr_` prefix is deliberate: a
 * manager-side one-off survives the manager Payments reconciler, which drops any other charge whose
 * resident has no approved application (`isManagerAddedOneOffCharge`). The charge carries the block id
 * as `guestStayBlockId` and NEVER as `shortStayBookingId`: that field is what the Stripe webhook reads
 * to settle a legacy pay-to-hold booking, and a confirmed stay must not mint a lease and an
 * application when it is paid.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertManagerCharges } from "@/lib/household-charges.server";
import type { HouseholdCharge } from "@/lib/household-charges";
import { shortTermStayChargeTitle } from "@/lib/short-term-stay-pricing";

export function guestStayChargeId(blockId: string): string {
  const slug = blockId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return `hc_mgr_stay_${slug || "unknown"}_stay_total`;
}

type StayBlockFacts = {
  nights: number;
  nightly: number;
  total: number;
};

function stayFacts(row: Record<string, unknown>): StayBlockFacts | null {
  const nightly = Number(row.rate);
  const nights = Number(row.quotedNights);
  const quoted = Number(row.quotedTotal);
  if (!Number.isFinite(nightly) || nightly <= 0 || !Number.isInteger(nights) || nights < 1) return null;
  const total = Number.isFinite(quoted) && quoted > 0 ? quoted : Math.round(nightly * nights * 100) / 100;
  return { nights, nightly, total };
}

export type EnsureStayChargeResult =
  | { ok: true; created: boolean; chargeId: string }
  | { ok: false; reason: "no_rate" | "no_guest" | "write_failed" };

export async function ensureGuestStayCharge(
  db: SupabaseClient,
  input: {
    blockId: string;
    ownerId: string;
    propertyId: string;
    propertyLabel: string;
    /** The stored `row_data` of the confirmed block. */
    row: Record<string, unknown>;
  },
): Promise<EnsureStayChargeResult> {
  const facts = stayFacts(input.row);
  if (!facts) return { ok: false, reason: "no_rate" };
  const residentUserId = typeof input.row.residentUserId === "string" ? input.row.residentUserId.trim() : "";

  // Payments finds a charge by the guest's LOGIN address, which is not always the email they typed.
  let residentEmail = "";
  if (residentUserId) {
    const { data: profile } = await db.from("profiles").select("email").eq("id", residentUserId).maybeSingle();
    residentEmail = String(profile?.email ?? "").trim().toLowerCase();
  }
  if (!residentEmail && typeof input.row.residentEmail === "string") residentEmail = input.row.residentEmail.trim().toLowerCase();
  if (!residentEmail) return { ok: false, reason: "no_guest" };

  const chargeId = guestStayChargeId(input.blockId);
  const { data: existing } = await db.from("portal_household_charge_records").select("id").eq("id", chargeId).maybeSingle();
  if (existing) return { ok: true, created: false, chargeId };

  const label = `$${facts.total.toFixed(2)}`;
  const charge: HouseholdCharge & { guestStayBlockId: string } = {
    id: chargeId,
    createdAt: new Date().toISOString(),
    residentEmail,
    residentName: typeof input.row.residentName === "string" && input.row.residentName.trim() ? input.row.residentName.trim() : "Guest",
    residentUserId: residentUserId || null,
    propertyId: input.propertyId,
    propertyLabel: input.propertyLabel,
    managerUserId: input.ownerId,
    kind: "stay_total",
    title: shortTermStayChargeTitle(facts.nights, facts.nightly),
    amountLabel: label,
    balanceLabel: label,
    status: "pending",
    blocksLeaseUntilPaid: false,
    // Visible in the guest's Payments the moment the stay is confirmed, not only inside the usual
    // window before its due date (a stay can be weeks out).
    residentVisibleAt: new Date().toISOString(),
    guestStayBlockId: input.blockId,
  };
  try {
    await upsertManagerCharges(db, input.ownerId, [charge as unknown as Record<string, unknown>]);
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, created: true, chargeId };
}
