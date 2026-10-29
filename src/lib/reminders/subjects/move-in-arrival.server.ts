/**
 * Move-in arrival -> the long-term resident's check-in message (checkin-1028).
 *
 *   move_in_arrival   24 h before the MOVE-IN INSTANT (the move-in date at the property's check-in time):
 *                     the same content as the guest's `stay_arrival_guide` (check-in time, address, door
 *                     and room codes, Wi-Fi, parking, house rules) plus a link to My home > Check-in.
 *
 * It rides the same switch as the guest's arrival guide (Settings -> Automations `arrival_guide`) and
 * the same reveal rule as the Check-in tab (`checkInReveal`): a resident whose lease is unsigned is
 * never sent a code, and the message is built from the house's CURRENT details at SEND time and never
 * stored in the queued row. Email + resident inbox always; text only where the row's notice channel
 * allows it (`noticeChannelFor`: a request made in the portal is answered by email and the inbox).
 *
 * A move-in confirmed inside the window still gets it, once, shortly before arrival (the same
 * catch-up the guest's guide has). Quiet hours are the workspace's shared window.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { buildArrivalGuideSmsText, buildArrivalGuideText } from "@/lib/bookings/arrival-guide";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { formatStayMoment } from "@/lib/bookings/stay-times";
import { loadTenancyCheckInContext, tenancyReveal } from "@/lib/check-in.server";
import { noticeChannelFor } from "@/lib/notice-channel";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";
import { materializeReminders, type ReminderQueueRow } from "@/lib/reminders/queue.server";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";
import { loadTenancies, tenancyMoveInInstantIso, tenancyRowFromRecord, type TenancyRow } from "@/lib/reminders/subjects/tenancy.server";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import { loadResidentLeaseSignedStatus, loadResidentManagerAttestedTenancy } from "@/lib/resident-portal-access";
import { formatIsoDateInput } from "@/lib/rental-application/lease-dates";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

/** A move-in is queued this far ahead of the message; the send itself is 24 h before the instant. */
const HORIZON_MS = 7 * 24 * 3_600_000;
const CATCH_UP_LEAD_MINUTES = 60;
const CATCH_UP_MIN_AHEAD_MINUTES = 10;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function checkInUrl(): string {
  return `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/resident/move-in/check-in`;
}

/** One tenancy, one move-in moment: a moved date is a different subject, so a re-sweep never double-sends. */
export function moveInArrivalSubjectId(recordId: string, anchorIso: string): string {
  return `tenancy:${recordId}:arrival:${anchorIso}`;
}

async function leaseUnlockedFor(email: string, managerUserId: string): Promise<boolean> {
  try {
    return (await loadResidentLeaseSignedStatus(email, managerUserId)) || (await loadResidentManagerAttestedTenancy(email, managerUserId));
  } catch {
    return false;
  }
}

async function hasQueued(db: SupabaseClient, subjectId: string): Promise<boolean> {
  const { data, error } = await db.from("portal_reminder_records").select("id").eq("kind", "move_in_arrival").eq("subject_id", subjectId).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function loadResidentUserIds(db: SupabaseClient, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  const { data, error } = await db.from("profiles").select("id, email").in("email", emails);
  if (error) throw error;
  for (const profile of (data ?? []) as Array<{ id?: unknown; email?: unknown }>) {
    const email = text(profile.email).toLowerCase();
    const id = text(profile.id);
    if (email && id) out.set(email, id);
  }
  return out;
}

/** The long-term residents moving in soon, one message each at their reveal moment. */
export async function sweepMoveInArrival(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const all = await loadTenancies(db);
  const upcoming = all.filter((row): row is TenancyRow & { moveIn: Date } => Boolean(row.moveIn) && row.moveIn!.getTime() > now.getTime() - 24 * 3_600_000);
  if (upcoming.length === 0) return 0;
  const resolver = await loadReminderSettingsResolver(db, [...new Set(upcoming.map((row) => row.managerUserId))]);
  const userIds = await loadResidentUserIds(db, [...new Set(upcoming.map((row) => row.residentEmail))]);
  const clocks = new Map<string, Awaited<ReturnType<typeof loadPropertyStayClock>>>();

  let queued = 0;
  for (const row of upcoming) {
    const settings = resolver.resolve(row.managerUserId, row.propertyId);
    const rule = settings.rules.move_in_arrival;
    if (!rule?.enabled) continue;
    const clockKey = row.propertyId ?? "";
    let clock = clocks.get(clockKey);
    if (!clock) {
      clock = await loadPropertyStayClock(db, row.propertyId);
      clocks.set(clockKey, clock);
    }
    const anchorIso = tenancyMoveInInstantIso(row.moveIn, clock);
    const anchorMs = Date.parse(anchorIso);
    if (!(anchorMs > now.getTime()) || anchorMs > now.getTime() + HORIZON_MS) continue;
    const residentUserId = row.residentUserId ?? userIds.get(row.residentEmail) ?? null;
    if (!residentUserId) continue;
    // No code is ever queued for a lease nobody has signed: the reveal rule needs the signature.
    if (!(await leaseUnlockedFor(row.residentEmail, row.managerUserId))) continue;

    const subjectId = moveInArrivalSubjectId(row.id, anchorIso);
    const input = {
      managerUserId: row.managerUserId,
      kind: "move_in_arrival" as const,
      subjectId,
      anchorIso,
      recipients: [{ email: row.residentEmail, role: "counterparty" as const, name: row.residentName, userId: residentUserId }],
      payload: {
        title: `check-in steps for ${row.propertyLabel || "your new home"}`,
        propertyLabel: row.propertyLabel,
        propertyId: row.propertyId ?? "",
        counterpartyName: row.residentName,
        whenLabel: formatStayMoment(formatIsoDateInput(row.moveIn), clock.times.checkInTime),
        url: checkInUrl(),
        notificationCategory: "leases" as const,
        tenancyRecordId: row.id,
      },
    };
    const withLead = (lead: number) => ({ ...settings, rules: { ...settings.rules, move_in_arrival: { ...rule, leadMinutes: [lead], timings: [`before:${lead}`] } } });
    if (anchorMs - 24 * 3_600_000 > now.getTime()) {
      queued += await materializeReminders(db, input, withLead(24 * 60), now);
    } else if ((anchorMs - now.getTime()) / 60_000 >= CATCH_UP_MIN_AHEAD_MINUTES && !(await hasQueued(db, subjectId))) {
      // Signed (or the date moved) after the 24 h mark: still once, shortly before they arrive.
      const lead = Math.min(CATCH_UP_LEAD_MINUTES, Math.max(5, Math.floor((anchorMs - now.getTime()) / 60_000) - 5));
      queued += await materializeReminders(db, input, withLead(lead), now);
    }
  }
  return queued;
}

async function loadTenancyForReminder(db: SupabaseClient, row: Pick<ReminderQueueRow, "managerUserId" | "payload">) {
  const recordId = text(row.payload.tenancyRecordId);
  if (!recordId) return null;
  const { data, error } = await db.from("manager_application_records").select("id, manager_user_id, resident_email, row_data").eq("id", recordId).maybeSingle();
  if (error) throw error;
  if (!data || text((data as { manager_user_id?: unknown }).manager_user_id) !== row.managerUserId) return null;
  const rowData = ((data as { row_data?: unknown }).row_data ?? {}) as Record<string, unknown>;
  if (hasSmsTestProvenance(rowData)) return null;
  const tenancy = tenancyRowFromRecord({
    id: recordId,
    manager_user_id: (data as { manager_user_id: string | null }).manager_user_id,
    resident_email: (data as { resident_email: string | null }).resident_email,
    row_data: rowData,
  });
  return tenancy ? { tenancy, rowData } : null;
}

/** Send-time currency: same resident, same move-in instant. */
export async function moveInArrivalIsCurrent(db: SupabaseClient, row: ReminderQueueRow): Promise<boolean> {
  if (row.kind !== "move_in_arrival" || row.recipientRole !== "counterparty") return false;
  const loaded = await loadTenancyForReminder(db, row);
  if (!loaded?.tenancy.moveIn) return false;
  if (loaded.tenancy.residentEmail !== row.recipientEmail.trim().toLowerCase()) return false;
  const clock = await loadPropertyStayClock(db, loaded.tenancy.propertyId);
  return reminderAnchorMatches(row.payload.anchorIso, tenancyMoveInInstantIso(loaded.tenancy.moveIn, clock));
}

export type RenderedMoveInArrival = {
  subject: string;
  body: string;
  smsText?: string;
  /** False when the row was made in the portal: email + inbox only, never a text (`noticeChannelFor`). */
  smsAllowed: boolean;
  guestUserId: string;
  propertyId: string;
};

/**
 * The resident's message, built from the house's CURRENT details at send time. Null when the reveal
 * rule does not hold (an unsigned lease, a move-in that moved out of the window): no code is sent then.
 */
export async function renderMoveInArrival(db: SupabaseClient, row: ReminderQueueRow, now: Date = new Date()): Promise<RenderedMoveInArrival | null> {
  if (row.kind !== "move_in_arrival") return null;
  const loaded = await loadTenancyForReminder(db, row);
  if (!loaded?.tenancy.moveIn) return null;
  const email = loaded.tenancy.residentEmail;
  const userId = text(row.payload.recipientUserId);
  if (!userId || email !== row.recipientEmail.trim().toLowerCase()) return null;
  // The login named on the queued row must be the one that owns this email.
  const { data: profile } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  if (text((profile as { id?: unknown } | null)?.id) !== userId) return null;

  const context = await loadTenancyCheckInContext(db, email, { managerUserId: row.managerUserId });
  if (!context || context.recordId !== loaded.tenancy.id) return null;
  const reveal = tenancyReveal(context, await leaseUnlockedFor(email, row.managerUserId), now);
  if (!reveal.revealed) return null;

  const resolved = await loadResidentMoveInForEmail(email, { db, managerUserId: row.managerUserId });
  if (!resolved) return null;
  const place = resolved.propertyLabel;
  const room = /^not assigned/i.test(resolved.roomLabel) ? "" : resolved.roomLabel;
  const dateKey = context.moveInDateKey ?? "";
  const input = {
    checkIn: dateKey,
    checkInTime: context.clock.times.checkInTime,
    checkInUrl: checkInUrl(),
    guestName: text(row.payload.recipientName) || loaded.tenancy.residentName,
    propertyLabel: place,
    addressLine: resolved.addressLine,
    roomLabel: room,
    roomDoorCode: resolved.roomDoorCode,
  };
  // The staff-only Internal section is already empty on `resolved.houseInfo` (`houseInfoWithoutInternal`).
  const smsAllowed = noticeChannelFor(loaded.rowData) !== "portal";
  return {
    subject: `Your check-in for ${[place, room].filter(Boolean).join(" ") || "your new home"}`,
    body: buildArrivalGuideText(resolved.houseInfo, input),
    ...(smsAllowed ? { smsText: buildArrivalGuideSmsText(resolved.houseInfo, input) } : {}),
    smsAllowed,
    guestUserId: userId,
    propertyId: context.propertyId ?? "",
  };
}
