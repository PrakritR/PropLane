import "server-only";

/**
 * Server loaders for the Check-in guide (`check-in-guide.ts`) and its reveal rule
 * (`check-in-reveal.ts`), for both audiences:
 *
 *   - a long-term resident, from their approved application row (`tenancy:<applicationRecordId>`);
 *   - a short-stay guest, from their confirmed stay (`stay:<blockId>`).
 *
 * Every id here is re-derived from the SESSION: the guest is the signed-in user on the stay row, the
 * resident is the email on the application row. A key in a request body is a name, never a grant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { checkInReveal, type CheckInReveal } from "@/lib/check-in-reveal";
import { buildCheckInGuide, type CheckInGuide, type CheckInSource } from "@/lib/check-in-guide";
import { loadPropertyStayClock, propertyStayClockFromRecord, type PropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { formatStayTime, wallInstantIso } from "@/lib/bookings/stay-times";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import { houseInfoWithoutInternal, normalizeHouseInfo } from "@/lib/house-info";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { formatIsoDateInput } from "@/lib/rental-application/lease-dates";
import { guestStayFromRow, stayTimelineFor } from "@/lib/reminders/subjects/stay-times.server";
import { tenancyRowFromRecord } from "@/lib/reminders/subjects/tenancy.server";
import { asObject, resolveBestResidentRow, type ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "Thursday, Oct 30" for a YYYY-MM-DD in the property's zone-independent calendar. */
function longDay(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export type TenancyCheckInContext = {
  recordId: string;
  managerUserId: string;
  propertyId: string | null;
  moveInDateKey: string | null;
  moveInAtIso: string | null;
  checkedInAt: string | null;
  clock: PropertyStayClock;
};

/**
 * The resident's current tenancy row and its move-in instant (the move-in date at the property's
 * check-in time, in the property's own zone). Null when the email has no approved application.
 */
export async function loadTenancyCheckInContext(
  db: SupabaseClient,
  email: string,
  options: { managerUserId?: string | null } = {},
): Promise<TenancyCheckInContext | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  let query = db.from("manager_application_records").select("id, manager_user_id, resident_email, row_data, updated_at").eq("resident_email", normalized);
  if (options.managerUserId) query = query.eq("manager_user_id", options.managerUserId);
  const { data } = await query.order("updated_at", { ascending: false });
  type TenancyEntry = { id: string; managerUserId: string; row: DemoApplicantRow };
  const entries: TenancyEntry[] = [];
  for (const record of (data ?? []) as Array<{ id: unknown; manager_user_id: unknown; row_data: unknown }>) {
    const row = asObject(record.row_data);
    const id = text(record.id);
    if (!row || !id) continue;
    entries.push({
      id,
      managerUserId: text(record.manager_user_id),
      row: { ...(row as unknown as DemoApplicantRow), email: text((row as { email?: unknown }).email).toLowerCase() || normalized },
    });
  }
  const current = entries.filter((entry) => isCurrentResidentApplicationRow(entry.row) && !entry.row.withdrawnAt);
  const pool = current.length > 0 ? current : entries;
  const best = resolveBestResidentRow(normalized, pool.map((entry) => entry.row));
  const entry = best ? pool.find((candidate) => candidate.row === best) : undefined;
  if (!entry) return null;

  const tenancy = tenancyRowFromRecord({
    id: entry.id,
    manager_user_id: entry.managerUserId,
    resident_email: normalized,
    row_data: entry.row as unknown as Record<string, unknown>,
  });
  const propertyId = tenancy?.propertyId ?? null;
  const clock = await loadPropertyStayClock(db, propertyId);
  const moveInDateKey = tenancy?.moveIn ? formatIsoDateInput(tenancy.moveIn) : null;
  return {
    recordId: entry.id,
    managerUserId: entry.managerUserId,
    propertyId,
    moveInDateKey,
    moveInAtIso: moveInDateKey ? wallInstantIso(moveInDateKey, clock.times.checkInTime, clock.timeZone) : null,
    checkedInAt: text((entry.row as unknown as { checkedInAt?: unknown }).checkedInAt) || null,
    clock,
  };
}

export function tenancyReveal(context: TenancyCheckInContext | null, leaseUnlocked: boolean, now: Date = new Date()): CheckInReveal {
  if (!context) return { revealed: false, reason: "no_time", revealAtIso: null };
  return checkInReveal({ kind: "tenancy", moveInAtIso: context.moveInAtIso, leaseSigned: leaseUnlocked }, now);
}

/**
 * The reveal for a resident's tenancy, for a caller that has no page (the assistant, the SMS fast
 * path). `leaseUnlocked` is the portal's own unlock (`leaseAccessUnlocked`: signed or attested).
 * Fail-closed: no tenancy row, or an unreadable one, is not revealed.
 */
export async function residentCheckInReveal(
  db: SupabaseClient,
  email: string,
  options: { managerUserId?: string | null; leaseUnlocked: boolean; now?: Date },
): Promise<CheckInReveal> {
  try {
    const context = await loadTenancyCheckInContext(db, email, { managerUserId: options.managerUserId });
    return tenancyReveal(context, options.leaseUnlocked, options.now);
  } catch {
    return { revealed: false, reason: "no_time", revealAtIso: null };
  }
}

/** The guide for a long-term resident's tenancy, from the UNMASKED resolved house (this builder masks the secrets itself). */
export function tenancyCheckInGuide(
  resolved: ResidentMoveInResolved,
  context: TenancyCheckInContext | null,
  reveal: CheckInReveal,
): CheckInGuide {
  const timeZone = context?.clock.timeZone;
  const checkInLabel =
    context?.moveInDateKey && context.clock.times.checkInTime
      ? `Move-in from ${formatStayTime(context.clock.times.checkInTime)} ${longDay(context.moveInDateKey)}`
      : null;
  const source: CheckInSource = {
    propertyLabel: resolved.propertyLabel,
    addressLine: resolved.addressLine,
    roomLabel: resolved.roomLabel,
    houseInfo: resolved.houseInfo,
    frontDoorPhotoUrl: resolved.frontDoorPhotoDataUrl,
    exteriorPhotoUrl: resolved.exteriorPhotoDataUrl,
    roomDoorCode: resolved.roomDoorCode,
    roomDoorPhotoUrl: resolved.roomDoorPhotoDataUrl,
    checkInLabel,
  };
  return buildCheckInGuide(source, reveal, {
    checkedInAt: context?.checkedInAt ?? null,
    checkInKey: context ? `tenancy:${context.recordId}` : null,
    timeZone,
  });
}

type PropertyRecord = { id?: unknown; row_data?: unknown; property_data?: unknown };

export type StayCheckIn = {
  guide: CheckInGuide;
  reveal: CheckInReveal;
  managerUserId: string;
  propertyId: string;
  roomId: string;
  guestName: string;
  propertyLabel: string;
  roomLabel: string;
};

/**
 * A short-stay guest's guide for ONE stay. The stay must be a confirmed room-date block that carries
 * this login (`row_data.residentUserId`); anything else is null (a hold, a cancelled stay, someone
 * else's stay). The codes reveal 24 hours before check-in and close again after checkout.
 */
export async function loadStayCheckIn(
  db: SupabaseClient,
  userId: string,
  blockId: string,
  now: Date = new Date(),
): Promise<StayCheckIn | null> {
  const id = blockId.trim();
  if (!id || !userId.trim()) return null;
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const record = data as Record<string, unknown>;
  if (record.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return null;
  const rowData = asObject(record.row_data) ?? {};
  const propertyId = text(record.property_id) || text(rowData.propertyId);
  const { data: propertyRecord } = propertyId
    ? await db.from("manager_property_records").select("id, row_data, property_data").eq("id", propertyId).maybeSingle()
    : { data: null };
  const property = (propertyRecord ?? null) as PropertyRecord | null;
  const clock = propertyStayClockFromRecord(property);
  const stay = guestStayFromRow(record, clock);
  if (!stay || stay.guestUserId !== userId.trim()) return null;

  const timeline = stayTimelineFor(stay, clock);
  const reveal = checkInReveal(
    {
      kind: "stay",
      checkInAtIso: timeline.checkInAt,
      checkOutAtIso: timeline.checkOutAt,
      status: text(rowData.bookingStatus),
    },
    now,
  );

  const propertyData = asObject(property?.property_data) ?? {};
  const submissionRaw = asObject(propertyData.listingSubmission) ?? asObject(asObject(property?.row_data)?.submission);
  const sub = submissionRaw?.v === 1 ? normalizeManagerListingSubmissionV1(submissionRaw as never) : null;
  const room = sub?.rooms.find((candidate) => candidate.id === stay.roomId) ?? null;
  const propertyLabel = sub?.buildingName?.trim() || text(propertyData.buildingName) || text(propertyData.title) || "";
  const roomLabel = room?.name?.trim() || "";
  const source: CheckInSource = {
    propertyLabel,
    addressLine: sub ? [sub.address, sub.zip].filter(Boolean).join(", ").trim() : text(propertyData.address),
    roomLabel,
    houseInfo: houseInfoWithoutInternal(normalizeHouseInfo(sub?.houseInfo)),
    frontDoorPhotoUrl: sub?.frontDoorPhotoDataUrl?.trim() || null,
    exteriorPhotoUrl: sub?.exteriorPhotoDataUrl?.trim() || null,
    roomDoorCode: room?.doorCode?.trim() || null,
    roomDoorPhotoUrl: room?.doorPhotoDataUrl?.trim() || null,
    checkInLabel: `Check-in from ${formatStayTime(stay.checkInTime)} ${longDay(stay.checkIn)}`,
    checkOutTimeLabel: formatStayTime(stay.checkOutTime),
  };
  const guide = buildCheckInGuide(source, reveal, {
    checkedInAt: text(asObject(rowData.stayDetails)?.checkedInAt) || null,
    checkInKey: `stay:${stay.blockId}`,
    timeZone: clock.timeZone,
  });
  return {
    guide,
    reveal,
    managerUserId: stay.managerUserId,
    propertyId: stay.propertyId,
    roomId: stay.roomId,
    guestName: stay.guestName,
    propertyLabel,
    roomLabel,
  };
}
