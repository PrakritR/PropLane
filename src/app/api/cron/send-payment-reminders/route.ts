import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { type HouseholdCharge, type RecurringRentProfile, filterChargesEligibleForPaymentReminders, isUnpaidHouseholdCharge } from "@/lib/household-charges";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { lateFeePolicyFromSubmission } from "@/lib/payment-policy";
import {
  loadManagerAutomationSettings,
  loadScheduledMessageOverrides,
  paymentReminderDedupId,
  legacyPaymentReminderDedupIds,
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
} from "@/lib/payment-automation-settings";
import { loadListingByPropertyId } from "@/lib/payment-automation-server";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import {
  deliverPaymentReminder,
  reminderHtmlFromText,
} from "@/lib/payment-reminder-delivery";
import { buildLateFeeNoticeText, buildLateFeeNoticeSubject } from "@/lib/payment-reminder-email";
import {
  projectScheduledPaymentMessages,
  shouldSendScheduledMessage,
} from "@/lib/scheduled-payment-messages";
import { householdChargeDueDate } from "@/lib/household-charges";

export const runtime = "nodejs";

const LATE_FEE_ELIGIBLE_KINDS = new Set<HouseholdCharge["kind"]>([
  "rent",
  "utilities",
  "first_month_rent",
  "prorated_rent",
  "prorated_utilities",
  "move_in_fee",
]);
const SENT_DEDUP_ID_LIMIT = 10000;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((startOfDay(b).getTime() - startOfDay(a).getTime()) / (1000 * 60 * 60 * 24));
}

function listingFromPropertyRow(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  const v = (submission as { v?: unknown }).v;
  if (v !== 1) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";

  const [{ data: records, error }, { data: profileRecords, error: profileError }] = await Promise.all([
    db
      .from("portal_household_charge_records")
      .select("id, row_data, manager_user_id")
      .eq("status", "pending"),
    db.from("portal_recurring_rent_profile_records").select("manager_user_id, row_data").limit(5000),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  const listingByPropertyId = await loadListingByPropertyId(db);

  const profilesByManager = new Map<string, RecurringRentProfile[]>();
  for (const row of profileRecords ?? []) {
    const profile = row.row_data as RecurringRentProfile;
    const managerId = (row.manager_user_id as string | null) ?? profile.managerUserId ?? "unknown";
    const list = profilesByManager.get(managerId) ?? [];
    list.push(profile);
    profilesByManager.set(managerId, list);
  }

  const allCharges = (records ?? [])
    .map((record) => ({
      recordId: record.id as string,
      managerUserId: record.manager_user_id as string | null,
      charge: record.row_data as HouseholdCharge | null,
    }))
    .filter((row): row is { recordId: string; managerUserId: string | null; charge: HouseholdCharge } =>
      Boolean(row.charge?.id && row.charge.residentEmail && isUnpaidHouseholdCharge(row.charge)),
    );

  const chargesByManager = new Map<string, HouseholdCharge[]>();
  for (const row of allCharges) {
    const mgr = row.managerUserId ?? row.charge.managerUserId ?? "unknown";
    const list = chargesByManager.get(mgr) ?? [];
    list.push(row.charge);
    chargesByManager.set(mgr, list);
  }

  const { data: outboundRows } = await db
    .from("portal_outbound_mail_records")
    .select("id")
    .or("id.like.payment_reminder_%,id.like.late_fee_notice_%")
    .limit(SENT_DEDUP_ID_LIMIT);
  const sentDedupIds = new Set((outboundRows ?? []).map((r) => String(r.id)));

  let sent = 0;
  let skipped = 0;
  let lateFeesCreated = 0;
  const errors: string[] = [];

  // Anti-spam: cap outbound emails per resident PER RUN so a resident with many
  // overdue charges never receives a burst of per-charge reminders + late-fee
  // notices in a single cron run (the reported bug: ~8 emails at once). Reminders
  // are sent first (more useful); once a resident hits the cap, further reminders
  // and every late-fee notice are suppressed for this run (the late-fee charge is
  // still created and visible in their portal).
  const MAX_EMAILS_PER_RESIDENT_PER_RUN = 1;
  const emailsToResidentThisRun = new Map<string, number>();
  const residentEmailBudgetLeft = (email: string) =>
    (emailsToResidentThisRun.get(email.trim().toLowerCase()) ?? 0) < MAX_EMAILS_PER_RESIDENT_PER_RUN;
  const noteResidentEmailed = (email: string) => {
    const k = email.trim().toLowerCase();
    emailsToResidentThisRun.set(k, (emailsToResidentThisRun.get(k) ?? 0) + 1);
  };

  // Guard against re-creating a late fee that already exists in ANY status.
  // `allCharges` is unpaid-only (status="pending"), so a PAID late fee would be
  // absent here and the deterministic `onConflict:"id"` upsert below would revert
  // it back to pending. Build the source set from EVERY late-fee record instead.
  const { data: lateFeeRows } = await db
    .from("portal_household_charge_records")
    .select("id, row_data")
    .eq("kind", "late_fee")
    .limit(SENT_DEDUP_ID_LIMIT);
  const existingLateFeeSources = new Set<string>();
  for (const row of lateFeeRows ?? []) {
    const sourceId = (row.row_data as HouseholdCharge | null)?.sourceChargeId;
    if (sourceId) existingLateFeeSources.add(sourceId);
    const idStr = String(row.id);
    if (idStr.startsWith("hc_late_fee_")) existingLateFeeSources.add(idStr.slice("hc_late_fee_".length));
  }

  for (const [managerId, charges] of chargesByManager) {
    if (managerId === "unknown") continue;

    const rentProfiles = profilesByManager.get(managerId) ?? [];
    const eligibleCharges = filterChargesEligibleForPaymentReminders(charges, rentProfiles);

    const [settings, overrides] = await Promise.all([
      loadManagerAutomationSettings(db, managerId).catch(() => DEFAULT_MANAGER_AUTOMATION_SETTINGS),
      loadScheduledMessageOverrides(db, managerId).catch(() => new Map()),
    ]);

    const { data: profile } = await db
      .from("profiles")
      .select("full_name, email, sms_from_number")
      .eq("id", managerId)
      .maybeSingle();
    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const managerSmsFromNumber = String(profile?.sms_from_number ?? "").trim();

    const scheduled = projectScheduledPaymentMessages({
      managerUserId: managerId,
      charges: eligibleCharges,
      settings,
      overrides,
      sentDedupIds,
      listingByPropertyId,
      managerName,
      now,
      includeHidden: true,
    });

    const chargeById = new Map(eligibleCharges.map((c) => [c.id, c]));

    for (const message of scheduled) {
      if (message.kind === "late_fee") continue;
      if (!shouldSendScheduledMessage(message, now)) {
        skipped++;
        continue;
      }

      const dedupCandidates = legacyPaymentReminderDedupIds({
        kind: message.kind,
        chargeId: message.chargeId,
        daysBeforeDue: message.daysBeforeDue ?? undefined,
      });
      const dedupId =
        message.kind === "overdue_daily"
          ? paymentReminderDedupId({ kind: "overdue_daily", chargeId: message.chargeId, todayKey })
          : dedupCandidates[0]!;

      if (sentDedupIds.has(dedupId) || dedupCandidates.some((id) => sentDedupIds.has(id))) {
        skipped++;
        continue;
      }

      const charge = chargeById.get(message.chargeId);
      if (!charge || !isUnpaidHouseholdCharge(charge)) {
        skipped++;
        continue;
      }

      // Per-resident email cap — don't send this resident a second reminder in
      // the same run.
      if (!residentEmailBudgetLeft(charge.residentEmail)) {
        skipped++;
        continue;
      }

      const result = await deliverPaymentReminder({
        db,
        charge,
        managerId,
        dedupId,
        managerName,
        managerSmsFromNumber,
        apiKey: apiKey ?? "",
        from,
        subject: message.subject,
        text: message.body,
        html: reminderHtmlFromText(message.body),
        slotLabel: message.typeLabel,
        managerDeliverViaEmail: settings.paymentReminderDeliverViaEmail,
        managerDeliverViaSms: settings.paymentReminderDeliverViaSms,
      });
      if (result.error) errors.push(result.error);
      if (result.sent) {
        sent++;
        sentDedupIds.add(dedupId);
        noteResidentEmailed(charge.residentEmail);
      }
    }

    for (const charge of eligibleCharges) {
      if (charge.residentEmail.trim().toLowerCase().endsWith("@axis.local")) continue;
      const dueDate = householdChargeDueDate(charge);
      if (!dueDate) continue;
      const hoursUntilDue = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursUntilDue >= 0) continue;

      if (LATE_FEE_ELIGIBLE_KINDS.has(charge.kind) && !existingLateFeeSources.has(charge.id)) {
        const listing = listingByPropertyId.get(charge.propertyId);
        const policy = lateFeePolicyFromSubmission(listing);
        const daysPastDue = daysBetween(dueDate, now);
        // Automated fee creation is opt-in via the same manager toggle that
        // gates the notice — matching the schedule projection
        // (scheduled-payment-messages.ts), which already requires both. A
        // listing-level policy alone must never create charges.
        if (settings.lateFeeNoticeEnabled && policy.enabled && daysPastDue >= policy.graceDays) {
          const lateFeeId = `hc_late_fee_${charge.id}`;
          const lateFeeCharge: HouseholdCharge = {
            id: lateFeeId,
            createdAt: new Date().toISOString(),
            residentEmail: charge.residentEmail,
            residentName: charge.residentName,
            residentUserId: charge.residentUserId,
            propertyId: charge.propertyId,
            propertyLabel: charge.propertyLabel,
            managerUserId: charge.managerUserId ?? managerId,
            kind: "late_fee",
            title: `Late fee — ${charge.title}`,
            amountLabel: policy.amountLabel,
            balanceLabel: policy.amountLabel,
            status: "pending",
            blocksLeaseUntilPaid: false,
            dueDateLabel: "Due immediately",
            sourceChargeId: charge.id,
            zelleContactSnapshot: charge.zelleContactSnapshot,
            venmoContactSnapshot: charge.venmoContactSnapshot,
          };

          await db.from("portal_household_charge_records").upsert(
            {
              id: lateFeeId,
              manager_user_id: lateFeeCharge.managerUserId,
              resident_user_id: lateFeeCharge.residentUserId ?? null,
              resident_email: charge.residentEmail.trim().toLowerCase(),
              kind: "late_fee",
              status: "pending",
              row_data: lateFeeCharge,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "id" },
          );
          await syncLedgerChargeEntry(db, lateFeeCharge).catch((e: unknown) => {
            const reason = e instanceof Error ? e.message : String(e);
            console.error(`[send-payment-reminders] ledger sync failed for late fee ${lateFeeId}: ${reason}`);
            errors.push(`Ledger sync failed for late fee ${lateFeeId}: ${reason}`);
          });

          existingLateFeeSources.add(charge.id);
          lateFeesCreated++;

          const noticeSubject = buildLateFeeNoticeSubject(charge.title, settings);
          const noticeText = buildLateFeeNoticeText({
            residentName: charge.residentName || "Resident",
            sourceTitle: charge.title,
            lateFeeLabel: policy.amountLabel,
            graceDays: policy.graceDays,
            propertyLabel: charge.propertyLabel,
            managerName,
          });
          const residentLower = charge.residentEmail.trim().toLowerCase();
          const noticeDedupId = `late_fee_notice_${lateFeeId}`;

          if (settings.lateFeeNoticeEnabled && !sentDedupIds.has(noticeDedupId)) {
            if (residentEmailBudgetLeft(charge.residentEmail)) {
              const result = await deliverPaymentReminder({
                db,
                charge: lateFeeCharge,
                managerId,
                dedupId: noticeDedupId,
                managerName,
                managerSmsFromNumber,
                apiKey: apiKey ?? "",
                from,
                subject: noticeSubject,
                text: noticeText,
                html: reminderHtmlFromText(noticeText),
                slotLabel: "late_fee_created",
                eventCategory: "payments",
                managerDeliverViaEmail: settings.paymentReminderDeliverViaEmail,
                managerDeliverViaSms: settings.paymentReminderDeliverViaSms,
              });
              if (result.error) errors.push(result.error);
              if (result.sent) noteResidentEmailed(charge.residentEmail);
            } else {
              await db.from("portal_outbound_mail_records").upsert(
                {
                  id: noticeDedupId,
                  recipient_email: residentLower,
                  subject: noticeSubject,
                  channel: "email",
                  row_data: {
                    id: noticeDedupId,
                    to: residentLower,
                    subject: noticeSubject,
                    body: noticeText,
                    sentAt: new Date().toISOString(),
                    chargeId: lateFeeId,
                    slot: "late_fee_created",
                    suppressedBurst: true,
                  },
                },
                { onConflict: "id" },
              );
            }
            sentDedupIds.add(noticeDedupId);
          }
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    sent,
    skipped,
    lateFeesCreated,
    errors: errors.length ? errors : undefined,
  });
}
