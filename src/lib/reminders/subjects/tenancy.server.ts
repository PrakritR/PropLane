/**
 * The tenancy calendar → the reminder queue (PLAN-0915 phase 2).
 *
 * A resident's dates live on their approved application row
 * (`manager_application_records`): `manualResidentDetails.moveInDate` /
 * `moveOutDate` when the manager set them by hand, else the application's
 * `leaseStart` / `leaseEnd`. Everything here anchors on those:
 *
 *   move_in                     7 and 1 days before move-in, resident + manager
 *   move_in_payment_method      before the first charge is due, when no card is on file
 *   lease_ending                60 and 30 days before the lease ends, resident
 *   lease_ending_manager        90, 60 and 30 days before, manager
 *   move_out                    30, 7, 1 days before an explicit move-out date, resident
 *   move_out_inspection_manager 14 days before, manager
 *   deposit_accounting          before the deposit deadline (move-out + N days), manager
 *
 * Move-out kinds fire only on an EXPLICIT move-out date: a lease end that may
 * roll into a renewal is a lease-ending notice, not a packing list.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { materializeReminders, type ReminderRecipient } from "@/lib/reminders/queue.server";
import type { ReminderSettings, ReminderSubjectKind } from "@/lib/reminders/rules";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { loadLeaseAutomationSettingsForManagers } from "@/lib/lease-automation-settings.server";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";

const MAX_ROWS = 1000;

export type TenancyRow = {
  id: string;
  managerUserId: string;
  residentEmail: string;
  residentUserId: string | null;
  residentName: string;
  propertyLabel: string;
  propertyId: string | null;
  moveIn: Date | null;
  leaseEnd: Date | null;
  /** Only when the manager set one explicitly. */
  moveOut: Date | null;
};

/** 09:00 Pacific on a local calendar date, as the reminder anchor. */
export function tenancyAnchorIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  // Pacific is UTC-7 (PDT) or UTC-8 (PST); pick by asking Intl for that date.
  const probe = new Date(`${y}-${m}-${d}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((part) => part.type === "timeZoneName")?.value;
  const hours = offset?.match(/GMT([+-]\d+)/)?.[1] ?? "-7";
  const sign = hours.startsWith("-") ? "-" : "+";
  const hh = String(Math.abs(Number(hours))).padStart(2, "0");
  return new Date(`${y}-${m}-${d}T09:00:00${sign}${hh}:00`).toISOString();
}

export function tenancyRowFromRecord(record: {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  row_data: Record<string, unknown>;
}): TenancyRow | null {
  const row = record.row_data;
  if (String(row.bucket ?? "") !== "approved" || row.withdrawnAt) return null;
  const managerUserId = String(record.manager_user_id ?? row.managerUserId ?? "").trim();
  const residentEmail = String(record.resident_email ?? row.email ?? "").trim().toLowerCase();
  if (!managerUserId || !residentEmail.includes("@")) return null;
  const manual = (row.manualResidentDetails ?? {}) as Record<string, unknown>;
  const application = (row.application ?? {}) as Record<string, unknown>;
  const moveIn = parseFlexibleLocalDate(String(manual.moveInDate ?? "")) ?? parseFlexibleLocalDate(String(application.leaseStart ?? ""));
  const moveOut = parseFlexibleLocalDate(String(manual.moveOutDate ?? ""));
  const leaseEnd = moveOut ?? parseFlexibleLocalDate(String(application.leaseEnd ?? ""));
  return {
    id: record.id,
    managerUserId,
    residentEmail,
    residentUserId: typeof row.residentUserId === "string" ? row.residentUserId : null,
    residentName: String(row.name ?? application.fullLegalName ?? "").trim() || "Resident",
    propertyLabel: String(row.property ?? "").trim(),
    propertyId: String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || null,
    moveIn,
    leaseEnd,
    moveOut,
  };
}

async function loadTenancies(db: SupabaseClient): Promise<TenancyRow[]> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? [])
    .filter((record): record is { id: string; manager_user_id: string | null; resident_email: string | null; row_data: Record<string, unknown> } =>
      Boolean((record as { row_data?: unknown }).row_data))
    .map((record) => tenancyRowFromRecord(record))
    .filter((row): row is TenancyRow => row !== null);
}

function origin(): string {
  return resolveEmailLinkBaseUrl().replace(/\/$/, "");
}

function dateLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

type Sweep = {
  kind: ReminderSubjectKind;
  anchor: (row: TenancyRow) => Date | null;
  audience: "resident" | "manager" | "both";
  url: string;
  category: "leases" | "payments";
  title: (row: TenancyRow) => string;
};

const SWEEPS: Sweep[] = [
  { kind: "move_in", anchor: (row) => row.moveIn, audience: "both", url: "/resident/my-home", category: "leases", title: () => "move-in" },
  { kind: "lease_ending", anchor: (row) => row.leaseEnd, audience: "resident", url: "/resident/lease", category: "leases", title: () => "lease" },
  { kind: "lease_ending_manager", anchor: (row) => row.leaseEnd, audience: "manager", url: "/portal/leases", category: "leases", title: () => "lease" },
  { kind: "move_out", anchor: (row) => row.moveOut, audience: "resident", url: "/resident/lease", category: "leases", title: () => "move-out" },
  { kind: "move_out_inspection_manager", anchor: (row) => row.moveOut, audience: "manager", url: "/portal/inspections", category: "leases", title: () => "move-out inspection" },
];

async function managerSide(
  db: SupabaseClient,
  row: TenancyRow,
  kind: ReminderSubjectKind,
  settings: ReminderSettings,
  managerRecipients: Map<string, { email: string; name: string | null }>,
): Promise<ReminderRecipient[]> {
  const out: ReminderRecipient[] = [];
  const manager = managerRecipients.get(row.managerUserId);
  if (manager) out.push({ email: manager.email, role: "manager", name: manager.name, userId: row.managerUserId });
  const rule = settings.rules[kind];
  if (rule.audience.team) {
    out.push(
      ...teamReminderRecipients(
        await loadTeamReminderRecipients(db, row.managerUserId, rule.teamUserIds ?? [], {
          module: REMINDER_SUBJECT_CO_MANAGER_MODULE[kind],
          propertyId: row.propertyId,
        }),
      ),
    );
  }
  return out;
}

export async function sweepTenancyReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = await loadTenancies(db);
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => row.managerUserId);
  const [reminderResolver, managerRecipients, leaseSettings] = await Promise.all([
    loadReminderSettingsResolver(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
    loadLeaseAutomationSettingsForManagers(db, managerIds),
  ]);
  let queued = 0;
  for (const row of rows) {
    // A house with its own reminder rules gets them; a lease with no property,
    // or an un-customized house, keeps the workspace rule (PLAN-0916-1040).
    const settings = reminderResolver.resolve(row.managerUserId, row.propertyId);
    for (const sweep of SWEEPS) {
      if (!settings.rules[sweep.kind]?.enabled) continue;
      const date = sweep.anchor(row);
      if (!date || date.getTime() <= now.getTime()) continue;
      const anchorIso = tenancyAnchorIso(date);
      const recipients: ReminderRecipient[] = [];
      if (sweep.audience !== "manager") recipients.push({ email: row.residentEmail, role: "counterparty", name: row.residentName, userId: row.residentUserId });
      if (sweep.audience !== "resident") recipients.push(...(await managerSide(db, row, sweep.kind, settings, managerRecipients)));
      if (recipients.length === 0) continue;
      queued += await materializeReminders(
        db,
        {
          managerUserId: row.managerUserId,
          kind: sweep.kind,
          subjectId: row.id,
          anchorIso,
          recipients,
          payload: {
            title: sweep.title(row),
            propertyLabel: row.propertyLabel,
            counterpartyName: row.residentName,
            whenLabel: dateLabel(date),
            dueDateLabel: dateLabel(date),
            url: `${origin()}${sweep.url}`,
            notificationCategory: sweep.category,
          },
        },
        settings,
        now,
      );
    }

    // Deposit accounting: the deadline is move-out + the manager's chosen days.
    if (row.moveOut && settings.rules.deposit_accounting.enabled) {
      const days = leaseSettings.get(row.managerUserId)?.depositAccountingDays ?? 21;
      const deadline = new Date(row.moveOut.getFullYear(), row.moveOut.getMonth(), row.moveOut.getDate() + days);
      if (deadline.getTime() > now.getTime()) {
        const recipients = await managerSide(db, row, "deposit_accounting", settings, managerRecipients);
        if (recipients.length > 0) {
          queued += await materializeReminders(
            db,
            {
              managerUserId: row.managerUserId,
              kind: "deposit_accounting",
              subjectId: row.id,
              anchorIso: tenancyAnchorIso(deadline),
              recipients,
              payload: {
                title: "deposit accounting",
                propertyLabel: row.propertyLabel,
                counterpartyName: row.residentName,
                whenLabel: dateLabel(deadline),
                dueDateLabel: dateLabel(deadline),
                url: `${origin()}/portal/payments`,
                notificationCategory: "payments",
              },
            },
            settings,
            now,
          );
        }
      }
    }
  }
  return queued;
}

/**
 * `move_in_payment_method` — a resident whose first charge is due soon and who
 * has no payment method on file (no Stripe customer). Anchored on the charge's
 * due date; the currency check re-reads both.
 */
export async function sweepMoveInPaymentMethod(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = await loadTenancies(db);
  const upcoming = rows.filter((row) => row.moveIn && row.moveIn.getTime() > now.getTime() - 3 * 24 * 60 * 60_000 && row.residentUserId);
  if (upcoming.length === 0) return 0;
  const residentIds = [...new Set(upcoming.map((row) => String(row.residentUserId)))];
  const { data: profiles } = await db.from("profiles").select("id, stripe_customer_id").in("id", residentIds);
  const hasMethod = new Set((profiles ?? []).filter((p) => String(p.stripe_customer_id ?? "").trim()).map((p) => String(p.id)));
  const needing = upcoming.filter((row) => !hasMethod.has(String(row.residentUserId)));
  if (needing.length === 0) return 0;
  const reminderResolver = await loadReminderSettingsResolver(db, needing.map((row) => row.managerUserId));
  let queued = 0;
  for (const row of needing) {
    const settings = reminderResolver.resolve(row.managerUserId, row.propertyId);
    if (!settings.rules.move_in_payment_method.enabled) continue;
    const { data: charges } = await db
      .from("portal_household_charge_records")
      .select("id, row_data")
      .eq("manager_user_id", row.managerUserId)
      .eq("resident_email", row.residentEmail)
      .limit(50);
    const first = (charges ?? [])
      .map((charge) => {
        const data = (charge.row_data ?? {}) as Record<string, unknown>;
        const status = String(data.status ?? "").toLowerCase();
        if (status === "paid" || status === "void" || status === "canceled") return null;
        const due = String(data.dueDateIso ?? data.dueDate ?? "");
        const ms = Date.parse(due.includes("T") ? due : `${due.slice(0, 10)}T12:00:00`);
        return Number.isFinite(ms) && ms > now.getTime() ? { id: String(charge.id), ms, amount: String(data.amountLabel ?? ""), title: String(data.title ?? "") } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.ms - b.ms)[0];
    if (!first) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.managerUserId,
        kind: "move_in_payment_method",
        subjectId: first.id,
        anchorIso: new Date(first.ms).toISOString(),
        recipients: [{ email: row.residentEmail, role: "counterparty", name: row.residentName, userId: row.residentUserId }],
        payload: {
          title: first.title || "first payment",
          amountLabel: first.amount,
          propertyLabel: row.propertyLabel,
          counterpartyName: row.residentName,
          whenLabel: dateLabel(new Date(first.ms)),
          dueDateLabel: dateLabel(new Date(first.ms)),
          url: `${origin()}/resident/payments`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
