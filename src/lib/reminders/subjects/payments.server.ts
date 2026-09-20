/**
 * Unpaid household charges → the reminder queue (manager side).
 *
 * `payment_manager` was fully configurable — defaults, Settings meta, a module
 * mapping, a "still relevant?" check — but no sweep ever created a row, so the
 * setting could never fire. This is that sweep.
 *
 * The subject is an open `portal_household_charge_records` row. Anchor
 * derivation and the closed-status set here MUST agree exactly with
 * `paymentManagerReminderIsCurrent` (`current.server.ts`): that function reads
 * the same table with the same fields, and a mismatched anchor makes every
 * queued row fail its "still current?" check and silently never send.
 *
 * Modelled on `outgoing-payments.server.ts` (same shape of subject — a bill
 * with a due date) and `leases.server.ts` (a manager-audience "after" chase,
 * not a "before" reminder — the due date itself can already be in the past by
 * the time this sweep runs, which `outgoing_payment`'s before-only horizon
 * check would wrongly exclude).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamRecipientsScopedToSubject,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import {
  createSettingsScopeCache,
  resolveReminderSettingsForRow,
} from "@/lib/reminders/settings.server";

/** Ceiling on rows examined per sweep, so one tick can never run unbounded. */
const MAX_ROWS = 500;
/**
 * `payment_manager`'s longest possible "after" offset is `MAX_TIMING_MINUTES`
 * (30 days, `timings.ts`). A charge due more than that many days ago can never
 * produce a future send time, so it is safe — and keeps the sweep bounded — to
 * stop examining anything older. No future cap: a charge due next month is
 * still a real subject to chase once it becomes overdue.
 */
const MAX_AGE_DAYS = 31;
const CLOSED_STATUSES = new Set(["paid", "void", "canceled"]);

type ChargeRecord = {
  id: string;
  manager_user_id: string | null;
  row_data: Record<string, unknown>;
};

/** Same rule `paymentManagerReminderIsCurrent` uses — keep them byte-identical. */
function chargeAnchorIso(charge: Record<string, unknown>): string | null {
  const dueIso = String(charge.dueDateIso ?? charge.dueDate ?? "");
  if (!dueIso.trim()) return null;
  const anchorIso = dueIso.includes("T") ? dueIso : new Date(`${dueIso.slice(0, 10)}T12:00:00`).toISOString();
  return Number.isFinite(Date.parse(anchorIso)) ? anchorIso : null;
}

/** Not future-bounded on purpose — only how far PAST due is still worth chasing. See MAX_AGE_DAYS. */
function withinAge(anchorIso: string, now: Date, maxAgeDays = MAX_AGE_DAYS): boolean {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function formatMoney(cents: unknown): string {
  const n = Number(cents);
  return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : "$0.00";
}

function amountLabelFor(charge: Record<string, unknown>): string {
  if (typeof charge.balanceLabel === "string" && charge.balanceLabel.trim()) return charge.balanceLabel.trim();
  if (typeof charge.amountLabel === "string" && charge.amountLabel.trim()) return charge.amountLabel.trim();
  return formatMoney(charge.amountCents ?? charge.balanceAmountCents);
}

function dueDateLabelFromAnchor(anchorIso: string): string {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "1 day overdue", "3 days overdue" — only used before the due date has passed does it read oddly, so callers gate on the anchor already being past `now`. */
function duePhraseFor(anchorIso: string, now: Date): string {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return "";
  const days = Math.round((now.getTime() - ms) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "due now";
  return `${days} ${days === 1 ? "day" : "days"} overdue`;
}

export async function sweepPaymentManagerReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("id, manager_user_id, row_data")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;

  const rows = (data ?? []).filter(
    (row): row is ChargeRecord =>
      typeof (row as { id?: unknown }).id === "string" && Boolean((row as { row_data?: unknown }).row_data),
  );
  if (rows.length === 0) return 0;

  const entries = rows
    .map((record) => {
      const managerUserId = String(record.manager_user_id ?? "").trim();
      if (!managerUserId) return null;
      const charge = (record.row_data ?? {}) as Record<string, unknown>;
      const status = String(charge.status ?? "").toLowerCase();
      if (CLOSED_STATUSES.has(status)) return null;
      const anchorIso = chargeAnchorIso(charge);
      if (!anchorIso || !withinAge(anchorIso, now)) return null;
      return { record, managerUserId, charge, anchorIso };
    })
    .filter(Boolean) as Array<{
    record: ChargeRecord;
    managerUserId: string;
    charge: Record<string, unknown>;
    anchorIso: string;
  }>;
  if (entries.length === 0) return 0;

  const managerUserIds = entries.map((entry) => entry.managerUserId);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerUserIds);
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");

  let queued = 0;
  for (const entry of entries) {
    const propertyId = typeof entry.charge.propertyId === "string" ? entry.charge.propertyId : null;
    // A house with its own reminder rules gets them; a charge with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, entry.managerUserId, propertyId);
    if (!settings.rules.payment_manager.enabled) continue;

    const managerRecipient = managerRecipients.get(entry.managerUserId);
    // Audience is the manager (and team), never the resident — the default
    // rule is `audience: { manager: true, counterparty: false, team: false }`.
    const teamRecipients = settings.rules.payment_manager.audience.team
      ? teamReminderRecipients(
          teamRecipientsScopedToSubject(
            await loadTeamReminderRecipients(db, entry.managerUserId, settings.rules.payment_manager.teamUserIds ?? []),
            propertyId,
            "payments",
          ),
        )
      : [];
    if (!managerRecipient && teamRecipients.length === 0) continue;

    const chargeTitle =
      typeof entry.charge.title === "string" && entry.charge.title.trim() ? entry.charge.title.trim() : "a charge";
    const residentName = typeof entry.charge.residentName === "string" ? entry.charge.residentName : null;
    const propertyTitle =
      typeof entry.charge.propertyLabel === "string" && entry.charge.propertyLabel.trim()
        ? entry.charge.propertyLabel.trim()
        : propertyId;

    queued += await materializeReminders(
      db,
      {
        managerUserId: entry.managerUserId,
        kind: "payment_manager",
        subjectId: entry.record.id,
        anchorIso: entry.anchorIso,
        recipients: [
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
        ],
        payload: {
          title: chargeTitle,
          chargeTitle,
          residentName,
          propertyTitle,
          propertyLabel: propertyTitle,
          amountLabel: amountLabelFor(entry.charge),
          dueDateLabel: dueDateLabelFromAnchor(entry.anchorIso),
          duePhrase: duePhraseFor(entry.anchorIso, now),
          url: `${origin}/portal/payments`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );

    // `delinquency_manager` (PLAN-0915): the same charge, much later — a
    // separate row so it has its own timing and can point at the notice tool
    // rather than nudge again. Never writes a notice itself.
    if (settings.rules.delinquency_manager?.enabled) {
      const delinquencyTeam = settings.rules.delinquency_manager.audience.team
        ? teamReminderRecipients(
            teamRecipientsScopedToSubject(
              await loadTeamReminderRecipients(db, entry.managerUserId, settings.rules.delinquency_manager.teamUserIds ?? []),
              propertyId,
              "payments",
            ),
          )
        : [];
      queued += await materializeReminders(
        db,
        {
          managerUserId: entry.managerUserId,
          kind: "delinquency_manager",
          subjectId: entry.record.id,
          anchorIso: entry.anchorIso,
          recipients: [
            ...(managerRecipient ? [{ email: managerRecipient.email, role: "manager" as const, name: managerRecipient.name, userId: entry.managerUserId }] : []),
            ...delinquencyTeam,
          ],
          payload: {
            title: chargeTitle,
            chargeTitle,
            residentName,
            counterpartyName: residentName,
            propertyTitle,
            propertyLabel: propertyTitle,
            amountLabel: amountLabelFor(entry.charge),
            dueDateLabel: dueDateLabelFromAnchor(entry.anchorIso),
            duePhrase: duePhraseFor(entry.anchorIso, now),
            url: `${origin}/portal/payments`,
            notificationCategory: "payments",
          },
        },
        settings,
        now,
      );
    }
  }
  return queued;
}
