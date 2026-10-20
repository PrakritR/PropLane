import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { ensureApplicationScopedSmsConsent } from "@/lib/sms/application-consent.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { mintRentReminderPayLink } from "@/lib/payments/rent-reminder-links.server";
import { composeRentReminderSms } from "@/lib/payments/rent-reminder-sms";
import { sendResidentRentText } from "@/lib/payments/rent-text-send.server";

/**
 * Weekly recurring rent-reminder SMS, sent from each manager's own PropLane
 * number. Idempotent PER WEEK through sms_outbox's owner + dedupe-key
 * constraint, including retries and concurrent cron invocations.
 *
 * Entitlement, registration, scoped automated consent, quiet hours, and the
 * campaign segment budget are rechecked by the durable dispatcher.
 */

const RENT_KINDS: ReadonlySet<HouseholdCharge["kind"]> = new Set([
  "rent",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
]);

/** ISO-8601 week key like `2026-W30`. Stable across a Mon–Sun week. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of the current week decides the ISO year.
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function residentKeyFor(charge: HouseholdCharge): string {
  const uid = String(charge.residentUserId ?? "").trim();
  if (uid) return `u_${uid}`;
  return `e_${charge.residentEmail.trim().toLowerCase()}`;
}

export function weeklyRentReminderDedupId(weekKey: string, managerUserId: string, residentKey: string): string {
  // Keyed per MANAGER per resident per week: a resident with pending charges
  // under two managers must get one reminder from EACH, not one total.
  return `weekly_rent_sms_${weekKey}_${managerUserId}_${residentKey}`;
}

export function reminderBody(charge: HouseholdCharge): string {
  const where = charge.propertyLabel?.trim() ? ` for ${charge.propertyLabel.trim()}` : "";
  const due = charge.dueDateLabel?.trim() ? ` (due ${charge.dueDateLabel.trim()})` : "";
  return `Rent reminder${where}: ${charge.amountLabel}${due}. Reply here with any questions.`;
}

export type WeeklyRentReminderResult = {
  considered: number;
  sent: number;
  skippedAlreadySent: number;
  skippedNoSendNumber: number;
  skippedNoPhone: number;
  failed: number;
  errors: Array<{ residentKey: string; error: string }>;
};

export async function sendWeeklyRentReminders(
  db: SupabaseClient,
  opts?: { now?: Date; managerUserId?: string },
): Promise<WeeklyRentReminderResult> {
  const now = opts?.now ?? new Date();
  const weekKey = isoWeekKey(now);
  const result: WeeklyRentReminderResult = {
    considered: 0,
    sent: 0,
    skippedAlreadySent: 0,
    skippedNoSendNumber: 0,
    skippedNoPhone: 0,
    failed: 0,
    errors: [],
  };

  let query = db
    .from("portal_household_charge_records")
    .select("row_data, manager_user_id")
    .eq("status", "pending")
    .limit(5000);
  if (opts?.managerUserId) query = query.eq("manager_user_id", opts.managerUserId);
  const { data: rows } = await query;

  // One rent charge per resident (dedupe by residentKey), grouped by manager.
  const byManager = new Map<string, Map<string, HouseholdCharge>>();
  for (const row of rows ?? []) {
    const charge = (row as { row_data: (HouseholdCharge & { smsTestSessionId?: string }) | null }).row_data;
    if (!charge?.id || charge.smsTestSessionId || !RENT_KINDS.has(charge.kind)) continue;
    const managerId = String((row as { manager_user_id: string | null }).manager_user_id ?? charge.managerUserId ?? "").trim();
    if (!managerId) continue;
    const residents = byManager.get(managerId) ?? new Map<string, HouseholdCharge>();
    const key = residentKeyFor(charge);
    if (!residents.has(key)) residents.set(key, charge);
    byManager.set(managerId, residents);
  }

  for (const [managerId, residents] of byManager) {
    for (const [residentKey, charge] of residents) {
      result.considered++;

      // Resolve a verified resident phone (never text an unverified number).
      let phone = "";
      let phoneVerifiedAt: string | null = null;
      if (charge.residentUserId) {
        const { data: prof } = await db
          .from("profiles")
          .select("phone, phone_verified_at")
          .eq("id", charge.residentUserId)
          .maybeSingle();
        if (prof?.phone_verified_at) {
          phone = String(prof?.phone ?? "").trim();
          phoneVerifiedAt = String(prof.phone_verified_at);
        }
      }
      if (!phone) {
        result.skippedNoPhone++;
        continue;
      }

      const dedupId = weeklyRentReminderDedupId(weekKey, managerId, residentKey);
      const conversationKey = buildConversationKey({
        ownerManagerUserId: managerId,
        role: "resident",
        counterpartyUserId: charge.residentUserId,
        counterpartyPhone: phone,
      });
      const consent = await ensureApplicationScopedSmsConsent(db, {
        managerUserId: managerId,
        recipientPhone: phone,
        recipientEmail: charge.residentEmail,
        recipientUserId: charge.residentUserId,
        purpose: "weekly_rent_reminder",
        sendClass: "automated",
        conversationKey,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? null,
      });
      if (!consent.ok || !consent.granted) {
        result.failed++;
        result.errors.push({
          residentKey,
          error: consent.ok ? "scoped_consent_missing" : consent.error,
        });
        continue;
      }
      // Already sent this week (the outbox dedupe key is the week's id, on either door).
      const { data: already } = await db
        .from("sms_outbox")
        .select("id, status")
        .eq("manager_user_id", managerId)
        .in("dedupe_key", [dedupId, `shared-line:${dedupId}`])
        .in("status", ["submitted", "sent", "delivered"])
        .limit(1);
      if ((already ?? []).length > 0) {
        result.skippedAlreadySent++;
        continue;
      }
      // Every reminder carries a fresh phone-bound pay link (or the portal URL without a verified phone) and
      // leaves from the line of the workspace that holds the house, the PropLane line included.
      const payLink = await mintRentReminderPayLink(db, {
        ownerUserId: managerId,
        charges: [charge],
        phone,
        phoneVerifiedAt,
      });
      const res = await sendResidentRentText(db, {
        ownerUserId: managerId,
        propertyId: charge.propertyId || null,
        phone,
        body: composeRentReminderSms({ text: reminderBody(charge), payLink: payLink.url, canonicalOrigin: resolveEmailLinkBaseUrl() }),
        purpose: "weekly_rent_reminder",
        sendClass: "automated",
        idempotencyKey: dedupId,
        residentUserId: charge.residentUserId ?? null,
        residentEmail: charge.residentEmail,
      });
      if (res.ok) {
        result.sent++;
      } else {
        const reason = String(res.error ?? "unknown");
        if (reason.includes("number_") || reason.includes("runtime") || reason.includes("provider_") || reason === "workspace_has_no_work_number") {
          result.skippedNoSendNumber++;
        } else {
          result.failed++;
          result.errors.push({ residentKey, error: reason });
        }
      }
    }
  }

  return result;
}
