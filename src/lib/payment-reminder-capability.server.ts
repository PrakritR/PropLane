import "server-only";

import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import { unitPriceCentsForMeter } from "@/lib/comms-billing/rates";
import type { HouseholdCharge } from "@/lib/household-charges";
import { resolvePropertyPayoutOwner } from "@/lib/payments/property-payout-owner.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { evaluateManagerSmsNumberSendability } from "@/lib/sms/number-registration-policy";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type PaymentReminderChargeContext = {
  charge: HouseholdCharge;
  ownerUserId: string;
  propertyId: string;
};

export type PaymentReminderCapability = {
  chargeId: string;
  ownerUserId: string;
  checkedAt: string;
  email: { available: boolean; reason: string | null };
  sms: { available: boolean; reason: string | null; fromNumber: string | null };
};

/** A charge ID is a lookup key, never permission to send for its owner. */
export async function loadPaymentReminderChargeForActor(
  db: ServiceClient,
  actorUserId: string,
  chargeId: string,
  admin = false,
): Promise<PaymentReminderChargeContext | null> {
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("row_data, manager_user_id, property_id")
    .eq("id", chargeId)
    .maybeSingle();
  if (error || !data?.row_data) return null;

  const charge = data.row_data as HouseholdCharge;
  const propertyId = String(data.property_id ?? charge.propertyId ?? "").trim();
  const propertyOwner = propertyId ? await resolvePropertyPayoutOwner(db, propertyId) : null;
  if (propertyOwner && (!propertyOwner.ok || !propertyOwner.ownerUserId)) return null;
  const ownerUserId = propertyOwner?.ok
    ? String(propertyOwner.ownerUserId ?? "").trim()
    : String(data.manager_user_id ?? "").trim();
  if (!ownerUserId) return null;
  if (admin || ownerUserId === actorUserId) return { charge, ownerUserId, propertyId };
  if (!propertyId) return null;

  // Both the payment record and the Communication send action must be granted
  // on this exact property by this exact owner. Empty permissions deny access.
  const [payments, communication] = await Promise.all([
    linkedOwnerScopeForModule(db, actorUserId, "payments", "read", { throwOnError: true }),
    linkedOwnerScopeForModule(db, actorUserId, "inbox", "edit", { throwOnError: true }),
  ]);
  if (
    !payments.propertyIdsByOwner.get(ownerUserId)?.has(propertyId) ||
    !communication.propertyIdsByOwner.get(ownerUserId)?.has(propertyId)
  ) return null;
  return { charge, ownerUserId, propertyId };
}

function smsReason(reason: string): string {
  switch (reason) {
    case "recipient_phone_missing": return "Add a phone number for this resident.";
    case "recipient_opted_out": return "This resident opted out of text messages.";
    case "allowance_exhausted": return "Workspace communication credit is exhausted.";
    case "number_missing": return "This workspace has no work number yet.";
    case "sms_ui_off": return "Text scheduling is not available yet.";
    case "runtime_env_paused":
    case "outbox_scheduler_unready":
    case "runtime_paused": return "Text delivery is temporarily unavailable.";
    default: return "Text delivery is unavailable for this workspace right now.";
  }
}

/** Read-only preview. Every send must repeat all authorization and policy checks. */
export async function resolvePaymentReminderCapability(
  db: ServiceClient,
  context: PaymentReminderChargeContext,
): Promise<PaymentReminderCapability> {
  const { charge, ownerUserId } = context;
  const recipientEmail = String(charge.residentEmail ?? "").trim().toLowerCase();
  const residentUserId = String(charge.residentUserId ?? "").trim();
  const profileQuery = db.from("profiles").select("id, phone, email");
  const [{ data: recipient, error: recipientError }, { data: number, error: numberError }, { data: runtime, error: runtimeError }] = await Promise.all([
    residentUserId
      ? profileQuery.eq("id", residentUserId).maybeSingle()
      : profileQuery.eq("email", recipientEmail).maybeSingle(),
    db.from("manager_sms_numbers")
      .select("phone_number, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason")
      .eq("manager_user_id", ownerUserId).maybeSingle(),
    db.from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true).maybeSingle(),
  ]);

  const emailReason = !recipientEmail.includes("@")
    ? "Add an email address for this resident."
    : shouldSkipOutboundEmail(recipientEmail)
      ? "External email is disabled for test accounts."
      : !process.env.RESEND_API_KEY?.trim()
        ? "Email delivery is not configured for this environment."
        : null;
  const result: PaymentReminderCapability = {
    chargeId: String(charge.id ?? ""),
    ownerUserId,
    checkedAt: new Date().toISOString(),
    email: { available: emailReason === null, reason: emailReason },
    sms: { available: false, reason: null, fromNumber: null },
  };
  let block: string | null = null;
  if (!isSmsCommUiEnabled()) block = "sms_ui_off";
  else if (process.env.SMS_RUNTIME_ENABLED?.trim() !== "1") block = "runtime_env_paused";
  else if (process.env.SMS_OUTBOX_SCHEDULER_READY?.trim() !== "1") block = "outbox_scheduler_unready";
  else if (recipientError || numberError || runtimeError || !runtime) block = "control_plane_unreadable";
  else if (residentUserId && recipientEmail && String(recipient?.email ?? "").trim().toLowerCase() !== recipientEmail) block = "recipient_identity_mismatch";
  else if (!recipient?.phone) block = "recipient_phone_missing";
  else {
    const decision = evaluateManagerSmsNumberSendability(
      number
        ? {
            provisionState: number.provision_state,
            phoneNumber: number.phone_number,
            registrationState: number.registration_state,
            registrationRef: number.registration_ref,
            attachmentState: number.attachment_state,
            numberRegistrationState: number.number_registration_state,
            graceStartedAt: number.grace_started_at,
            graceExpiresAt: number.grace_expires_at,
            quarantinedAt: number.quarantined_at,
            quarantineReason: number.quarantine_reason,
          }
        : null,
      {
        runtimeMode: runtime.mode,
        managerIsAllowlisted: Array.isArray(runtime.pilot_manager_user_ids) && runtime.pilot_manager_user_ids.includes(ownerUserId),
      },
    );
    if (!decision.sendable) block = decision.reason ?? "number_unavailable";
    else {
      const [billing, suppression] = await Promise.all([
        evaluateManagerCommsBillingGate(db, ownerUserId, unitPriceCentsForMeter("sms_outbound_segment")),
        readSmsSuppressionState(db, String(recipient.phone), { userId: residentUserId || recipient.id }),
      ]);
      if (!billing.allowed) block = billing.reason;
      else if (!suppression.ok) block = suppression.error;
      else if (suppression.optedOut) block = "recipient_opted_out";
      else result.sms = { available: true, reason: null, fromNumber: String(number?.phone_number ?? "") };
    }
  }
  if (block) result.sms.reason = smsReason(block);
  return result;
}
