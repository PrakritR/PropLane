import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";
import { mintRentReminderPayLink } from "@/lib/payments/rent-reminder-links.server";
import { composeRentReminderSms } from "@/lib/payments/rent-reminder-sms";

/** The payment events whose resident text is a request to pay: it carries a link that opens that charge. */
const PAY_REQUEST_EVENTS: ReadonlySet<string> = new Set(["charge_created", "payment_failed", "late_fee_applied", "partial_received"]);

export function isPayRequestPaymentEvent(domain: string | undefined, event: string | undefined): boolean {
  return domain === "payment" && PAY_REQUEST_EVENTS.has(String(event ?? ""));
}

/**
 * The text for a payment-request event (a new charge, a failed payment, a late fee, a part payment), with a link that
 * opens exactly that charge: a fresh phone-bound `/l/<token>` (tap, a code to the same phone, pay) when the resident has
 * a verified phone, else their Payments page. Built from the STORED charge row - the resident, the amount owed and the
 * workspace come from it, never from the event text - and only while the charge is still unpaid and belongs to the
 * recipient. Returns null (the caller keeps the ordinary text) on any doubt; it never throws.
 *
 * Only the SMS leg uses it: a portal-channel resident is never sent this text (`notice-channel.ts`), and the in-app copy
 * wears the event card whose Pay button opens the same charge.
 */
export async function chargeEventSmsWithPayLink(
  db: SupabaseClient,
  input: { managerUserId: string; chargeId: string; recipientUserId?: string | null; recipientEmail?: string | null; text: string },
): Promise<string | null> {
  try {
    const chargeId = input.chargeId.trim();
    if (!chargeId || !input.text.trim()) return null;
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("row_data, manager_user_id")
      .eq("id", chargeId)
      .maybeSingle();
    const charge = (row?.row_data ?? null) as HouseholdCharge | null;
    if (!charge?.id || !isUnpaidHouseholdCharge(charge)) return null;
    const ownerId = String(row?.manager_user_id ?? "").trim() || input.managerUserId;
    if (!ownerId) return null;

    const email = String(input.recipientEmail ?? "").trim().toLowerCase();
    const userId = String(input.recipientUserId ?? "").trim();
    const owns = charge.residentUserId
      ? Boolean(userId) && charge.residentUserId === userId
      : Boolean(email) && charge.residentEmail.trim().toLowerCase() === email;
    if (!owns) return null;

    const { data: profile } = await db
      .from("profiles")
      .select("phone, phone_verified_at")
      .eq(userId ? "id" : "email", userId || email)
      .maybeSingle();
    const link = await mintRentReminderPayLink(db, {
      ownerUserId: ownerId,
      charges: [charge],
      phone: (profile?.phone as string | null) ?? null,
      phoneVerifiedAt: (profile?.phone_verified_at as string | null) ?? null,
    });
    return composeRentReminderSms({ text: input.text, payLink: link.url, canonicalOrigin: resolveEmailLinkBaseUrl() });
  } catch {
    return null;
  }
}
