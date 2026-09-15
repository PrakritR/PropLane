import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { buildResidentWelcomeSmsBody } from "@/lib/resident-welcome.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveWorkspaceWorkNumbers } from "@/lib/sms/manager-workspace-role.server";
import { normalizeProvisionState } from "@/lib/sms/number-registration-policy";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import { loadReceipts } from "@/lib/portfolio-import/store.server";
import { track } from "@/lib/analytics/posthog";
import type { PortfolioImportInviteChannel, PortfolioImportInviteResult } from "@/lib/portfolio-import/types";

export type PortfolioImportInviteActor = {
  userId: string;
  email: string | null;
  managerName?: string;
};

/** This account's own outbound work number, when one is active. */
export async function portfolioImportMessagingStatus(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ workNumber: string | null; canText: boolean; settingsHref: string }> {
  const workspace = await resolveWorkspaceWorkNumbers(db, managerUserId).catch(() => null);
  const own = workspace?.numbers.find((n) => n.ownerUserId === managerUserId) ?? null;
  const workNumber =
    own && normalizeProvisionState(own.provisionState) === "active" && own.phoneNumber?.trim() ? own.phoneNumber.trim() : null;
  return { workNumber, canText: Boolean(workNumber), settingsHref: MANAGER_MESSAGING_SETTINGS_HREF };
}

async function loadOwnedApplicationRow(
  db: SupabaseClient,
  managerUserId: string,
  applicationId: string,
): Promise<DemoApplicantRow | null> {
  const { data } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("id", applicationId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  return (data?.row_data as DemoApplicantRow | null) ?? null;
}

async function stampWelcomeSent(db: SupabaseClient, applicationId: string, managerUserId: string, row: DemoApplicantRow): Promise<void> {
  await db
    .from("manager_application_records")
    .update({
      row_data: { ...row, manualResidentDetails: { ...row.manualResidentDetails, onboardingWelcomeSentAt: new Date().toISOString() } },
      updated_at: new Date().toISOString(),
    })
    .eq("id", applicationId)
    .eq("manager_user_id", managerUserId);
}

/**
 * Invite already-committed import residents to set up their portal accounts —
 * explicit, never automatic on commit. Email reuses the existing-resident
 * onboarding pipeline (the same welcome email every "add resident" flow
 * sends); text reuses the manager's OWN work number and the identical
 * message body, so a resident who gets both channels reads the same offer
 * twice, not two different ones.
 */
export async function invitePortfolioImportResidents(input: {
  db: SupabaseClient;
  managerUserId: string;
  actor: PortfolioImportInviteActor;
  importId: string;
  residentKeys: string[];
  channels: PortfolioImportInviteChannel;
}): Promise<{ results: PortfolioImportInviteResult[]; workNumber: string | null }> {
  const { db, managerUserId, actor, importId, residentKeys, channels } = input;
  const wantsEmail = channels === "email" || channels === "both";
  const wantsText = channels === "text" || channels === "both";

  const receipts = await loadReceipts(db, importId);
  const residentReceiptByKey = new Map(
    receipts.filter((r) => r.record_kind === "resident" && r.status === "completed").map((r) => [r.source_key, r]),
  );

  const messaging = await portfolioImportMessagingStatus(db, managerUserId);

  const results: PortfolioImportInviteResult[] = [];
  let emailCount = 0;
  let textCount = 0;

  for (const residentKey of residentKeys) {
    const receipt = residentReceiptByKey.get(residentKey);
    const applicationId = receipt?.canonical_id ?? null;
    if (!applicationId) {
      results.push({
        residentKey,
        applicationId: null,
        email: wantsEmail ? "failed" : "not_requested",
        text: wantsText ? "failed" : "not_requested",
        error: "This resident was not imported — nothing to invite.",
      });
      continue;
    }

    const row = await loadOwnedApplicationRow(db, managerUserId, applicationId);
    if (!row) {
      results.push({
        residentKey,
        applicationId,
        email: wantsEmail ? "failed" : "not_requested",
        text: wantsText ? "failed" : "not_requested",
        error: "Resident record not found.",
      });
      continue;
    }

    const result: PortfolioImportInviteResult = {
      residentKey,
      applicationId,
      email: "not_requested",
      text: "not_requested",
    };

    const alreadySent = Boolean(row.manualResidentDetails?.onboardingWelcomeSentAt?.trim());
    const email = row.email?.trim().toLowerCase() ?? "";
    const phone = row.manualResidentDetails?.phone?.trim() ?? "";

    if (wantsEmail) {
      if (!email) {
        result.email = "skipped_no_email";
      } else if (alreadySent) {
        result.email = "already_sent";
      } else {
        const onboarded = await runExistingResidentOnboarding(
          db,
          { userId: actor.userId, email: actor.email, managerName: actor.managerName },
          row,
          { sendWelcomeEmail: true, preserveExistingLease: true },
        );
        if (onboarded.ok) {
          result.email = onboarded.welcomeEmailSent ? "sent" : "already_sent";
          if (onboarded.welcomeEmailSent) emailCount += 1;
        } else {
          result.email = "failed";
          result.error = onboarded.error;
        }
      }
    }

    if (wantsText) {
      if (!messaging.workNumber) {
        result.text = "skipped_no_work_number";
      } else if (!phone) {
        result.text = "skipped_no_phone";
      } else if (alreadySent && result.email !== "sent") {
        // The welcome sentence was already delivered (by email or a prior text) —
        // a text-only resident's own send is what set the stamp, so treat this
        // exactly like the email branch's `already_sent`.
        result.text = "already_sent";
      } else {
        const axisId = applicationId;
        const body = buildResidentWelcomeSmsBody({
          residentName: row.name,
          axisId,
          senderName: actor.managerName?.trim() || actor.email || "Your property manager",
          propertyLabel: row.property,
        });
        const enqueued = await enqueueOwnerSms(
          {
            managerUserId,
            actorUserId: actor.userId,
            recipientPhone: phone,
            recipientEmail: email || null,
            body,
            sendClass: "transactional",
            purpose: "resident_welcome",
            counterpartyRole: "resident",
            dedupeKey: `welcome:import:${importId}:${residentKey}`,
          },
          db,
        );
        if (enqueued.ok) {
          result.text = "sent";
          textCount += 1;
          // A text-only resident (no email requested/available) still needs the
          // "already welcomed" stamp so a second invite call reads `already_sent`
          // instead of re-texting them.
          if (!email || !wantsEmail) await stampWelcomeSent(db, applicationId, managerUserId, row);
        } else {
          result.text = "failed";
          result.error = result.error ?? enqueued.error ?? "Could not send the text.";
        }
      }
    }

    results.push(result);
  }

  track("portfolio_import_invites_sent", managerUserId, { emailCount, textCount });

  return { results, workNumber: messaging.workNumber };
}

// Re-exported for callers that only need the display formatting.
export { formatProplaneIdForDisplay };
