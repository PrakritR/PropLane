import type { SupabaseClient } from "@supabase/supabase-js";

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { chargeOwnedByUser } from "@/lib/stripe-household-charge-checkout.server";
import type { HouseholdCharge, ResidentChargeMessage } from "@/lib/household-charges";
import {
  RESIDENT_CHARGE_MESSAGE_MAX_LENGTH,
  RESIDENT_CHARGE_MESSAGE_MIN_LENGTH,
} from "@/lib/resident-charge-message";

export { RESIDENT_CHARGE_MESSAGE_MAX_LENGTH, RESIDENT_CHARGE_MESSAGE_MIN_LENGTH };

export function sanitizeResidentChargeMessageBody(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, RESIDENT_CHARGE_MESSAGE_MAX_LENGTH);
}

export function buildResidentChargeMessageSubject(charge: HouseholdCharge): string {
  const title = charge.title.trim() || "Charge";
  return `Question about ${title}`;
}

export function buildResidentChargeMessageBody(charge: HouseholdCharge, message: string): string {
  const lines = [
    "A resident sent a message about a charge.",
    "",
    `Charge: ${charge.title}`,
    `Amount due: ${charge.balanceLabel}`,
    `Property: ${charge.propertyLabel}`,
    "",
    "Message:",
    message,
  ];
  return lines.join("\n");
}

type SendResidentChargeMessageInput = {
  userId: string;
  userEmail: string;
  residentName: string;
  chargeId: string;
  message: string;
};

export type SendResidentChargeMessageResult =
  | { ok: true; charge: HouseholdCharge }
  | { ok: false; status: number; error: string };

export async function sendResidentChargeMessage(
  db: SupabaseClient,
  input: SendResidentChargeMessageInput,
): Promise<SendResidentChargeMessageResult> {
  const chargeId = input.chargeId.trim();
  const body = sanitizeResidentChargeMessageBody(input.message);
  if (!chargeId) {
    return { ok: false, status: 400, error: "chargeId is required." };
  }
  if (body.length < RESIDENT_CHARGE_MESSAGE_MIN_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Enter at least ${RESIDENT_CHARGE_MESSAGE_MIN_LENGTH} characters.`,
    };
  }

  const { data: row, error: rowError } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, manager_user_id, status")
    .eq("id", chargeId)
    .maybeSingle();
  if (rowError) {
    return { ok: false, status: 500, error: rowError.message };
  }
  if (!row?.row_data) {
    return { ok: false, status: 404, error: "Charge not found." };
  }

  const charge = row.row_data as HouseholdCharge;
  const userEmail = input.userEmail.trim().toLowerCase();
  if (!chargeOwnedByUser(charge, input.userId, userEmail)) {
    return { ok: false, status: 403, error: "You can only message about your own charges." };
  }

  const managerUserId = String(row.manager_user_id ?? charge.managerUserId ?? "").trim();
  if (!managerUserId) {
    return { ok: false, status: 400, error: "This charge is not linked to a property manager yet." };
  }

  const sentAt = new Date().toISOString();
  const entry: ResidentChargeMessage = {
    id: `rcm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    body,
    sentAt,
    residentUserId: input.userId,
  };
  const prior = Array.isArray(charge.residentChargeMessages) ? charge.residentChargeMessages : [];
  const nextCharge: HouseholdCharge = {
    ...charge,
    residentChargeMessages: [...prior, entry],
  };

  const delivery = await deliverPortalInboxMessage(db, {
    senderUserId: input.userId,
    senderEmail: userEmail,
    fromName: input.residentName.trim() || "Resident",
    subject: buildResidentChargeMessageSubject(charge),
    text: buildResidentChargeMessageBody(charge, body),
    toUserIds: [managerUserId],
    deliverToPortalInbox: true,
    senderRole: "resident",
    eventCategory: "payments",
    threadIdentity: {
      managerUserId,
      ...(charge.propertyId ? { propertyId: charge.propertyId } : {}),
      ...(charge.propertyLabel ? { propertyTitle: charge.propertyLabel } : {}),
    },
  });
  if (!delivery.ok) {
    return { ok: false, status: 400, error: delivery.error };
  }

  const { error: updateError } = await db
    .from("portal_household_charge_records")
    .update({
      row_data: nextCharge,
      updated_at: sentAt,
    })
    .eq("id", chargeId);
  if (updateError) {
    return { ok: false, status: 500, error: updateError.message };
  }

  return { ok: true, charge: nextCharge };
}
