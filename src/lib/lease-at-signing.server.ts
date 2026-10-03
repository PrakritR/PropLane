import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import { householdChargeProplanePayability } from "@/lib/household-charge-payment-eligibility";
import { enrichHouseholdChargesFromPropertyRecordsResult } from "@/lib/household-charge-payment-eligibility.server";
import {
  atSigningTotalCents,
  chargesForLeaseSigning,
  unpaidAtSigningCharges,
} from "@/lib/lease-at-signing";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

const CHARGE_TABLE = "portal_household_charge_records";

/** Reason the gate could not answer: the signature waits and the resident retries (503). */
export const AT_SIGNING_ELIGIBILITY_UNRESOLVED =
  "Could not confirm how this property collects payment; the signature was not recorded.";

type LeaseLike = {
  axisId?: string | null;
  residentEmail?: string | null;
  propertyId?: string | null;
  leaseKind?: string | null;
  jointLeaseMembers?: ReadonlyArray<{ applicationId?: string | null; residentEmail?: string | null }> | null;
};

export type AtSigningGateResult =
  | { ok: true; unpaid: HouseholdCharge[]; unpaidCents: number }
  | { ok: false; error: string };

/**
 * The resident's own at-signing lines for ONE lease, read from the server's charge records.
 *
 * `paid` is only ever written by the Stripe webhook (or its server-side session verify) — never from a
 * client body — so this is the webhook-confirmed answer. It reads the signer's own charges by identity and
 * narrows them to the lease with the same rule the browser uses (`chargesForLeaseSigning`).
 */
export async function loadAtSigningChargesForLease(
  db: SupabaseClient,
  input: { lease: LeaseLike; residentUserId: string; residentEmail: string },
): Promise<{ ok: true; charges: HouseholdCharge[] } | { ok: false; error: string }> {
  const email = input.residentEmail.trim().toLowerCase();
  const identityFilter = orFilterForIdentity([
    ["resident_user_id", input.residentUserId],
    ["resident_email", email],
  ]);
  // A signer we cannot name owes nothing we can find; the signature route already refuses unscoped writers.
  if (!identityFilter) return { ok: true, charges: [] };

  const { data, error } = await db.from(CHARGE_TABLE).select("id, status, row_data").or(identityFilter);
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as Array<{ id: string; status?: string | null; row_data: unknown }>;
  const charges: HouseholdCharge[] = [];
  for (const row of rows) {
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge || typeof charge !== "object" || !charge.id) continue;
    // The status COLUMN is what the webhook and the manager both write; it wins over a stale document.
    const status = (row.status as HouseholdCharge["status"] | null | undefined) ?? charge.status;
    charges.push({ ...charge, status });
  }

  const lease = input.lease;
  const members = lease.leaseKind === "joint_bundle" ? lease.jointLeaseMembers ?? [] : [];
  const applicationIds = [lease.axisId ?? "", ...members.map((m) => m.applicationId ?? "")].filter((id) => id.trim());
  const residentEmails = [email, lease.residentEmail ?? "", ...members.map((m) => m.residentEmail ?? "")].filter((e) =>
    e.trim(),
  );
  return {
    ok: true,
    charges: chargesForLeaseSigning(
      charges,
      { applicationIds, residentEmails, propertyId: lease.propertyId },
      normalizeApplicationAxisId,
    ),
  };
}

/**
 * May this resident's signature be recorded? Only when none of THEIR at-signing lines is unpaid.
 * Fails closed: if the charges cannot be read, the signature waits rather than slipping through.
 *
 * Only a line the resident can actually PAY in PropLane gates the signature. A property whose listing
 * SAYS it collects offline (PropLane payments off, or no usable payout account) offers the resident no
 * checkout, so blocking on it would trap them behind a payment they cannot make; there the manager records
 * the payment and the line is collected exactly as it was before this gate existed.
 *
 * A line whose listing could not be resolved at all is NOT that case. "Cannot determine" fails closed -
 * `ok: false`, which the signature route answers 503 and the resident retries - because reading it as
 * "collects offline" is what let every owed line drop out of `unpaid` after one failed property read.
 *
 * Only a line STAMPED with its payment snapshot when it was created gates the signature. A line created
 * before the gate existed carries no snapshot, and on the server its listing may be unresolvable for
 * good (`getPropertyById` reads a catalog that exists only in a manager's browser) - so gating on it
 * would be a permanent 503 inviting a retry that can never succeed. Those lines stay owed and payable
 * exactly as they were; they simply do not lock Sign.
 */
export async function checkResidentAtSigningGate(
  db: SupabaseClient,
  input: { lease: LeaseLike; residentUserId: string; residentEmail: string },
): Promise<AtSigningGateResult> {
  const loaded = await loadAtSigningChargesForLease(db, input);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const mine = loaded.charges.filter((charge) => {
    // Only the signer's own lines gate their signature (a co-resident's unpaid line gates theirs).
    const owner = charge.residentUserId?.trim();
    if (owner && input.residentUserId) return owner === input.residentUserId;
    return charge.residentEmail.trim().toLowerCase() === input.residentEmail.trim().toLowerCase();
  });
  const owed = unpaidAtSigningCharges(mine);
  const gating = owed.filter((charge) => typeof charge.axisPaymentsEnabledSnapshot === "boolean");
  if (gating.length === 0) return { ok: true, unpaid: [], unpaidCents: 0 };
  const { charges: enriched, lookupFailed } = await enrichHouseholdChargesFromPropertyRecordsResult(db, gating);
  const payability = enriched.map((charge) => householdChargeProplanePayability(charge));
  // A failed read cannot change a line the listing itself calls offline, so it only
  // blocks when some line's answer actually depended on what could not be read.
  const unresolved =
    payability.some((answer) => answer === "unknown") ||
    (lookupFailed && payability.some((answer) => answer !== "offline"));
  if (unresolved) return { ok: false, error: AT_SIGNING_ELIGIBILITY_UNRESOLVED };
  const unpaid = enriched.filter((_, index) => payability[index] === "payable");
  return { ok: true, unpaid, unpaidCents: atSigningTotalCents(unpaid) };
}
