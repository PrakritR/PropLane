import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import type { HouseholdCharge } from "@/lib/household-charges";
import { chargePaymentReference } from "@/lib/manual-payment-instructions";
import { canPayHouseholdChargeWithManualChannel } from "@/lib/platform/resident-payments";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";

/**
 * The resident "I paid via Zelle/Venmo" core, extracted from
 * `/api/portal/resident-report-manual-payment` so the resident agent's
 * report_manual_payment tool and the API route share one implementation. The
 * route's per-charge re-checks are all kept: existence, not already paid,
 * ownership by the reporting resident, and channel eligibility (a Zelle/Venmo
 * contact must exist on the charge). Charges stay `pending` — the manager
 * verifies receipt and marks them paid.
 */

export type ResidentManualPaymentFailure = {
  ok: false;
  /** HTTP status the API route responds with. */
  status: number;
  error: string;
};

export type ResidentManualPaymentResult =
  | { ok: true; charges: HouseholdCharge[] }
  | ResidentManualPaymentFailure;

export async function reportResidentManualPayment(
  db: SupabaseClient,
  input: {
    userId: string;
    userEmail: string;
    chargeIds: string[];
    channel: "zelle" | "venmo";
    expectedManagerUserId?: string;
  },
): Promise<ResidentManualPaymentResult> {
  const { channel } = input;
  const userEmail = input.userEmail.trim().toLowerCase();
  const uniqueIds = [...new Set(input.chargeIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: false, status: 400, error: "chargeIds is required." };
  }

  const now = new Date().toISOString();
  const updated: HouseholdCharge[] = [];
  const managerIds = new Set<string>();

  for (const id of uniqueIds) {
    const { data: row, error: rowErr } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status, manager_user_id")
      .eq("id", id)
      .maybeSingle();

    if (rowErr) return { ok: false, status: 500, error: rowErr.message };
    if (!row) return { ok: false, status: 404, error: `Charge not found: ${id}` };

    const charge = row.row_data as HouseholdCharge | null;
    if (!charge?.id) return { ok: false, status: 500, error: "Invalid charge record." };
    if (row.status === "paid" || charge.status === "paid") {
      return { ok: false, status: 409, error: "One or more selected charges are already paid." };
    }
    if (!chargeOwnedByUser(charge, input.userId, userEmail)) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }
    if (!canPayHouseholdChargeWithManualChannel(charge, channel)) {
      return {
        ok: false,
        status: 422,
        error: `One or more charges cannot be paid with ${channel === "venmo" ? "Venmo" : "Zelle"}.`,
      };
    }

    const managerUserId = (row.manager_user_id as string | null)?.trim() || charge.managerUserId?.trim() || "";
    if (input.expectedManagerUserId && managerUserId !== input.expectedManagerUserId) {
      return { ok: false, status: 403, error: "You do not have access to one of the selected charges." };
    }
    if (managerUserId) managerIds.add(managerUserId);

    const patched: HouseholdCharge = {
      ...charge,
      manualPaymentChannel: channel,
      manualPaymentReportedAt: now,
    };
    updated.push(patched);

    const { error: upsertErr } = await db.from("portal_household_charge_records").upsert(
      {
        id,
        manager_user_id: managerUserId || null,
        resident_user_id: charge.residentUserId,
        resident_email: charge.residentEmail.trim().toLowerCase(),
        property_id: charge.propertyId,
        kind: charge.kind,
        status: charge.status,
        row_data: patched,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (upsertErr) return { ok: false, status: 500, error: upsertErr.message };
  }

  const channelLabel = channel === "venmo" ? "Venmo" : "Zelle";
  const senderEmail = userEmail || "resident@axis.local";
  for (const managerUserId of managerIds) {
    const detailLines = updated.map((charge) => {
      const ref = chargePaymentReference(charge);
      const amount = charge.balanceLabel?.trim() || charge.amountLabel?.trim() || "";
      return `• ${charge.title} — ${amount} (reference ${ref})`;
    });
    await deliverPortalInboxMessage(db, {
      senderUserId: input.userId,
      senderEmail,
      fromName: "Resident payment",
      subject: `${channelLabel} payment reported`,
      text: [
        `A resident reported sending ${updated.length === 1 ? "a payment" : `${updated.length} payments`} via ${channelLabel}.`,
        "",
        ...detailLines,
        "",
        "Open Payments to verify and mark paid, or forward the receipt email to your PropPlane payments inbox for automatic matching.",
      ].join("\n"),
      toUserIds: [managerUserId],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
    }).catch(() => undefined);
  }

  track("manual_payment_reported", input.userId, { channel, charge_count: updated.length });
  return { ok: true, charges: updated };
}

function chargeOwnedByUser(charge: HouseholdCharge, userId: string, email: string): boolean {
  const e = email.trim().toLowerCase();
  if (charge.residentUserId && charge.residentUserId === userId) return true;
  return Boolean(e && charge.residentEmail.trim().toLowerCase() === e);
}
