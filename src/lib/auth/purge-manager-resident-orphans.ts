/**
 * Manager-scoped cleanup after a resident is removed from the directory.
 *
 * Used by `/api/portal/purge-orphaned-records` (`current_only`) so charges,
 * rent profiles, leases, reminders, scheduled messages, ledger lines, and
 * related rows for emails that are no longer current residents do not linger
 * in Payments / reminders after Delete resident.
 *
 * Does NOT touch Airbnb occupancy placeholders (`*@import.proplane.local`).
 * Does NOT delete manager-role reminder rows (task reminders to co-managers).
 */

import { hasMoveOutDatePassed, isPreviousResidentStage } from "@/lib/current-resident";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Occupancy / Airbnb import placeholders are not “deleted residents.” */
export function isProtectedOccupancyImportEmail(email: string): boolean {
  return email.endsWith("@import.proplane.local");
}

function isCurrentResidentRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const record = row as {
    bucket?: unknown;
    stage?: unknown;
    manualResidentDetails?: { moveOutDate?: unknown } | null;
  };
  const bucket = typeof record.bucket === "string" ? record.bucket.trim().toLowerCase() : "";
  if (bucket !== "approved") return false;
  const moveOutRaw =
    record.manualResidentDetails && typeof record.manualResidentDetails === "object"
      ? record.manualResidentDetails.moveOutDate
      : undefined;
  const moveOut = typeof moveOutRaw === "string" ? moveOutRaw : undefined;
  if (hasMoveOutDatePassed(moveOut)) return false;
  const stage = typeof record.stage === "string" ? record.stage : undefined;
  return !isPreviousResidentStage(stage);
}

export type ManagerResidentOrphanPurgeResult = {
  deleted: Record<string, number>;
  purgedEmails: string[];
  deletedApplicationIds: string[];
  activeEmails: string[];
};

type EmailColumnTable = {
  table: string;
  emailCol: "resident_email" | "recipient_email";
  /** Extra filter: only delete when this column matches (e.g. resident reminders). */
  requireCol?: { column: string; equals: string };
};

const MANAGER_EMAIL_TABLES: readonly EmailColumnTable[] = [
  { table: "portal_household_charge_records", emailCol: "resident_email" },
  { table: "portal_recurring_rent_profile_records", emailCol: "resident_email" },
  { table: "portal_lease_pipeline_records", emailCol: "resident_email" },
  { table: "portal_work_order_records", emailCol: "resident_email" },
  { table: "portal_service_request_records", emailCol: "resident_email" },
  { table: "manager_payment_plans", emailCol: "resident_email" },
  { table: "ledger_entries", emailCol: "resident_email" },
  { table: "security_deposit_ledger", emailCol: "resident_email" },
  {
    table: "portal_reminder_records",
    emailCol: "recipient_email",
    requireCol: { column: "recipient_role", equals: "resident" },
  },
];

/**
 * Delete manager-owned portal rows whose resident email is no longer a current
 * (or under-review) directory member for that manager.
 */
export async function purgeManagerResidentOrphans(
  db: ServiceDb,
  managerUserId: string,
  options: { currentOnly?: boolean } = {},
): Promise<ManagerResidentOrphanPurgeResult> {
  const currentOnly = options.currentOnly !== false;
  const managerId = managerUserId.trim();
  if (!managerId) {
    return { deleted: {}, purgedEmails: [], deletedApplicationIds: [], activeEmails: [] };
  }

  const { data: applications } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("manager_user_id", managerId);

  const activeEmails = new Set<string>();
  const deletedApplicationIds: string[] = [];
  const orphanedEmails = new Set<string>();

  for (const record of applications ?? []) {
    const email = normalizeEmail(record.resident_email);
    if (currentOnly) {
      const rowBucket = (record.row_data as { bucket?: unknown } | null)?.bucket;
      const stillUnderReview = typeof rowBucket === "string" && rowBucket.trim().toLowerCase() !== "approved";
      if (stillUnderReview) {
        if (email) activeEmails.add(email);
        continue;
      }
      const keep = email && isCurrentResidentRow(record.row_data);
      if (keep) {
        activeEmails.add(email);
      } else {
        if (email) orphanedEmails.add(email);
        if (record.id) deletedApplicationIds.push(record.id);
      }
    } else if (email) {
      activeEmails.add(email);
    }
  }

  if (activeEmails.size === 0) {
    return {
      deleted: {},
      purgedEmails: [...orphanedEmails],
      deletedApplicationIds,
      activeEmails: [],
    };
  }

  const deleted: Record<string, number> = {};

  async function deleteByEmailColumn(spec: EmailColumnTable): Promise<void> {
    let query = db.from(spec.table).select(`id, ${spec.emailCol}`).eq("manager_user_id", managerId);
    if (spec.requireCol) {
      query = query.eq(spec.requireCol.column, spec.requireCol.equals);
    }
    const { data: records } = await query;
    const orphanIds = (records ?? [])
      .filter((r) => {
        const email = normalizeEmail(r[spec.emailCol]);
        if (!email || isProtectedOccupancyImportEmail(email)) return false;
        return !activeEmails.has(email);
      })
      .map((r) => {
        const email = normalizeEmail(r[spec.emailCol]);
        if (email) orphanedEmails.add(email);
        return r.id as string;
      })
      .filter(Boolean);

    if (orphanIds.length > 0) {
      await db.from(spec.table).delete().in("id", orphanIds);
    }
    deleted[spec.table] = orphanIds.length;
  }

  for (const spec of MANAGER_EMAIL_TABLES) {
    await deleteByEmailColumn(spec);
  }

  // Scheduled inbox: recipient lives in row_data
  const { data: scheduled } = await db
    .from("portal_scheduled_inbox_message_records")
    .select("id, row_data")
    .eq("manager_user_id", managerId);
  const orphanSchedIds = (scheduled ?? [])
    .filter((row) => {
      const email = normalizeEmail(
        row.row_data && typeof row.row_data === "object"
          ? (row.row_data as Record<string, unknown>).recipientEmail
          : "",
      );
      if (!email || isProtectedOccupancyImportEmail(email)) return false;
      return !activeEmails.has(email);
    })
    .map((row) => {
      const email = normalizeEmail(
        row.row_data && typeof row.row_data === "object"
          ? (row.row_data as Record<string, unknown>).recipientEmail
          : "",
      );
      if (email) orphanedEmails.add(email);
      return row.id as string;
    })
    .filter(Boolean);
  if (orphanSchedIds.length > 0) {
    await db.from("portal_scheduled_inbox_message_records").delete().in("id", orphanSchedIds);
  }
  deleted.portal_scheduled_inbox_message_records = orphanSchedIds.length;

  // Inbox threads: owner is manager, participant is resident
  const { data: inboxRecords } = await db
    .from("portal_inbox_thread_records")
    .select("id, participant_email")
    .eq("owner_user_id", managerId);
  const orphanInboxIds = (inboxRecords ?? [])
    .filter((r) => {
      const email = normalizeEmail(r.participant_email);
      if (!email || isProtectedOccupancyImportEmail(email)) return false;
      return !activeEmails.has(email);
    })
    .map((r) => {
      const email = normalizeEmail(r.participant_email);
      if (email) orphanedEmails.add(email);
      return r.id as string;
    })
    .filter(Boolean);
  if (orphanInboxIds.length > 0) {
    await db.from("portal_inbox_thread_records").delete().in("id", orphanInboxIds);
  }
  deleted.portal_inbox_thread_records = orphanInboxIds.length;

  if (currentOnly && deletedApplicationIds.length > 0) {
    await db.from("manager_application_records").delete().in("id", deletedApplicationIds);
  }
  deleted.manager_application_records = currentOnly ? deletedApplicationIds.length : 0;

  return {
    deleted,
    purgedEmails: [...orphanedEmails],
    deletedApplicationIds,
    activeEmails: [...activeEmails],
  };
}
