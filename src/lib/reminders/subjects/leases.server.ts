/**
 * Lease pipeline → the reminder queue.
 *
 * Manager review and resident signature are separate audiences with different
 * anchors, so each row may queue manager/team reminders, resident reminders,
 * or both — but never after the lease has moved on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipientsByManager,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import type { ReminderRecipient } from "@/lib/reminders/queue.server";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";

const MAX_ROWS = 500;
const MAX_AGE_DAYS = 180;

type LeaseRecord = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  row_data: Record<string, unknown>;
  updated_at: string;
};

function leaseAnchorIso(row: LeasePipelineRow, mode: "manager" | "resident"): string | null {
  const raw =
    mode === "resident"
      ? row.sentToResidentAt?.trim() || row.updatedAtIso?.trim() || ""
      : row.updatedAtIso?.trim() || row.sentToResidentAt?.trim() || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function withinAge(anchorIso: string, now: Date, maxAgeDays = MAX_AGE_DAYS): boolean {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function leaseNeedsManagerReminder(row: LeasePipelineRow): boolean {
  return row.status === "Manager Review" || row.status === "Draft";
}

function leaseNeedsResidentReminder(row: LeasePipelineRow): boolean {
  return row.status === "Resident Signature Pending" || row.bucket === "resident";
}

export async function sweepLeaseReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, resident_email, row_data, updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;

  const rows = (data ?? []).filter(
    (row): row is LeaseRecord =>
      typeof (row as { id?: unknown }).id === "string" &&
      Boolean((row as { row_data?: unknown }).row_data),
  );
  if (rows.length === 0) return 0;

  const candidates = rows
    .map((record) => {
      const lease = normalizeLeasePipelineRow(record.row_data);
      const managerUserId = String(record.manager_user_id ?? lease.managerUserId ?? "").trim();
      if (!managerUserId) return null;
      if (lease.status === "Fully Signed" || lease.status === "Voided") return null;
      const needsManager = leaseNeedsManagerReminder(lease);
      const needsResident = leaseNeedsResidentReminder(lease);
      if (!needsManager && !needsResident) return null;

      const managerAnchor = needsManager ? leaseAnchorIso(lease, "manager") : null;
      const residentAnchor = needsResident ? leaseAnchorIso(lease, "resident") : null;
      const anchorIso = residentAnchor ?? managerAnchor;
      if (!anchorIso || !withinAge(anchorIso, now)) return null;

      const residentEmail = (lease.residentEmail?.trim() || record.resident_email?.trim() || "").toLowerCase();
      return {
        record,
        lease,
        managerUserId,
        managerAnchor,
        residentAnchor,
        residentEmail,
      };
    })
    .filter(Boolean) as Array<{
    record: LeaseRecord;
    lease: LeasePipelineRow;
    managerUserId: string;
    managerAnchor: string | null;
    residentAnchor: string | null;
    residentEmail: string;
  }>;
  if (candidates.length === 0) return 0;

  const managerIds = candidates.map((entry) => entry.managerUserId);
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);
  const teamRecipientsByManager = await loadTeamReminderRecipientsByManager(
    db,
    managerIds.map((managerUserId) => ({
      managerUserId,
      teamUserIds: settingsByManager.get(managerUserId)?.rules.lease.teamUserIds ?? [],
    })),
  );
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");

  let queued = 0;
  for (const entry of candidates) {
    const settings = settingsByManager.get(entry.managerUserId);
    if (!settings?.rules.lease.enabled) continue;
    const managerRecipient = managerRecipients.get(entry.managerUserId);
    const teamRecipients = settings.rules.lease.audience.team
      ? teamReminderRecipients(teamRecipientsByManager.get(entry.managerUserId) ?? [])
      : [];
    const leaseUrl = `${origin}/resident/lease`;
    const propertyLabel = entry.lease.unit?.trim() || null;

    const queueForAnchor = async (anchorIso: string | null, recipients: ReminderRecipient[]) => {
      if (!anchorIso || recipients.length === 0) return 0;
      return materializeReminders(
        db,
        {
          managerUserId: entry.managerUserId,
          kind: "lease",
          subjectId: entry.record.id,
          anchorIso,
          recipients,
          payload: {
            title: propertyLabel ? `Lease for ${propertyLabel}` : "Lease signature",
            propertyLabel,
            counterpartyName: entry.lease.residentName ?? null,
            residentName: entry.lease.residentName ?? null,
            leaseUrl,
            url: leaseUrl,
            notificationCategory: "leases",
          },
        },
        settings,
        now,
      );
    };

    const managerSide: ReminderRecipient[] = [
      ...(managerRecipient
        ? [
            {
              email: managerRecipient.email,
              role: "manager" as const,
              name: managerRecipient.name,
              userId: entry.managerUserId,
            },
          ]
        : []),
      ...teamRecipients,
    ];

    if (entry.managerAnchor && leaseNeedsManagerReminder(entry.lease)) {
      queued += await queueForAnchor(entry.managerAnchor, managerSide);
    }
    if (entry.residentAnchor && leaseNeedsResidentReminder(entry.lease) && entry.residentEmail.includes("@")) {
      queued += await queueForAnchor(entry.residentAnchor, [
        {
          email: entry.residentEmail,
          role: "counterparty",
          name: entry.lease.residentName ?? null,
        },
      ]);
    }
  }
  return queued;
}
