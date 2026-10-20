import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import type { HouseholdCharge } from "@/lib/household-charges";
import { mintRentReminderPayLink } from "@/lib/payments/rent-reminder-links.server";
import { composeRentReminderSms } from "@/lib/payments/rent-reminder-sms";
import { sendResidentRentText } from "@/lib/payments/rent-text-send.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import type { HouseSubject, LeaseSubject } from "./moments";
import { loadRentDueTodayForHouse } from "./sources.server";

/**
 * "Friendly reminder: rent is due today. Check your texts for your pay link." is a promise the house group
 * text makes, so it is kept: right after that text goes out, every resident of the house with rent due today
 * and a verified phone gets their OWN text with their own phone-bound pay link (tap, a code to this phone,
 * pay by card). The group text still names no one and no amount; the private text names the amount and
 * carries the link.
 *
 * One text per resident per due day (the idempotency key carries the day and the charges). A resident the
 * house roster cannot match to a charge, or with no verified phone, is simply not texted here: the daily
 * reminder reaches them by email and the inbox as before.
 */
export async function sendRentDueDayLinks(
  db: SupabaseClient,
  input: { house: HouseSubject; roster: readonly LeaseSubject[]; todayKey: string },
): Promise<{ sent: number; skipped: number }> {
  let charges: HouseholdCharge[];
  try {
    charges = await loadRentDueTodayForHouse(db, input.house.propertyId, input.todayKey);
  } catch {
    return { sent: 0, skipped: 0 };
  }
  const byResident = new Map<string, HouseholdCharge[]>();
  for (const charge of charges) {
    const id = String(charge.residentUserId ?? "").trim();
    if (!id) continue;
    byResident.set(id, [...(byResident.get(id) ?? []), charge]);
  }
  let sent = 0;
  let skipped = 0;
  for (const lease of input.roster) {
    const owed = lease.residentUserId ? byResident.get(lease.residentUserId) : undefined;
    if (!owed?.length || !lease.phoneKey) {
      skipped += 1;
      continue;
    }
    const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", lease.residentUserId!).maybeSingle();
    const phone = String((profile as { phone?: unknown } | null)?.phone ?? "");
    const verifiedAt = String((profile as { phone_verified_at?: unknown } | null)?.phone_verified_at ?? "") || null;
    if (!verifiedAt || normalizeConsentPhone(phone) !== lease.phoneKey) {
      skipped += 1;
      continue;
    }
    const payLink = await mintRentReminderPayLink(db, {
      ownerUserId: input.house.ownerUserId,
      charges: owed,
      phone,
      phoneVerifiedAt: verifiedAt,
    });
    const amount = owed.length === 1 ? ` of ${owed[0]!.balanceLabel || owed[0]!.amountLabel}` : "";
    const result = await sendResidentRentText(db, {
      ownerUserId: input.house.ownerUserId,
      propertyId: input.house.propertyId,
      phone,
      body: composeRentReminderSms({
        text: `Rent${amount} for ${input.house.propertyLabel} is due today.`,
        payLink: payLink.url,
        canonicalOrigin: resolveEmailLinkBaseUrl(),
      }),
      purpose: "rent_due_link",
      sendClass: "automated",
      idempotencyKey: `rent-due-link:${input.todayKey}:${owed.map((c) => c.id).sort().join(",")}`,
      residentUserId: lease.residentUserId,
      residentEmail: lease.residentEmail,
    });
    if (result.ok) sent += 1;
    else skipped += 1;
  }
  return { sent, skipped };
}
