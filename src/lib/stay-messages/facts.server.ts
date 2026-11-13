import "server-only";

/**
 * Database readers for the stay-message sweep (design-1112 §7): the stays that could be messaged, the property record they
 * are about, and the workspace's settings. Reads only; nothing here sends. Every reader fails closed (an unreadable table
 * yields no stays, never a guess), and the codes are read here for the SEND-time builder, never stored anywhere.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { propertyStayClockFromRecord } from "@/lib/bookings/property-stay-times.server";
import { resolveStayTimes, type StayAddOns, normalizeStayTime, stayTimeMinutes } from "@/lib/bookings/stay-times";
import { houseInfoWithoutInternal, normalizeHouseInfo, type HouseInfoV1 } from "@/lib/house-info";
import { CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE, ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { loadResidentLeaseSignedStatus, loadResidentManagerAttestedTenancy } from "@/lib/resident-portal-access";
import { loadTenancies } from "@/lib/reminders/subjects/tenancy.server";
import { formatIsoDateInput } from "@/lib/rental-application/lease-dates";
import { normalizeE164 } from "@/lib/phone-e164";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";
import { normalizeStayMessageSettings, staySourceOf, type StayMessageSettings } from "@/lib/stay-messages/templates";
import type { StayCandidate, StayProperty, StayRoom } from "@/lib/stay-messages/types";

const MAX_ROWS = 500;
const DAY_MS = 24 * 3_600_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type PropertyRow = { id?: unknown; workspace_id?: unknown; manager_user_id?: unknown; row_data?: unknown; property_data?: unknown };

export function stayPropertyFromRecord(record: PropertyRow): StayProperty {
  const data = asRecord(record.property_data);
  const submission = asRecord(data.listingSubmission);
  const rooms: StayRoom[] = (Array.isArray(submission.rooms) ? submission.rooms : []).map((raw, index) => {
    const room = asRecord(raw);
    return { id: text(room.id), label: text(room.name) || `Room ${index + 1}`, doorCode: text(room.doorCode) };
  }).filter((room) => room.id);
  const address = [text(submission.address) || text(data.address), text(submission.zip)].filter(Boolean).join(", ");
  const clock = propertyStayClockFromRecord({ row_data: record.row_data, property_data: record.property_data });
  return {
    propertyId: text(record.id),
    label: text(submission.buildingName) || text(data.buildingName) || text(data.title) || text(data.address),
    addressLine: address,
    timeZone: clock.timeZone,
    // The FULL details (Internal included) are kept only as a deny list; the builder strips Internal before reading values.
    houseInfo: normalizeHouseInfo(submission.houseInfo),
    rooms,
  };
}

export async function loadStayProperty(db: SupabaseClient, propertyId: string): Promise<StayProperty | null> {
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id, manager_user_id, row_data, property_data").eq("id", propertyId).maybeSingle();
  if (error || !data) return null;
  return stayPropertyFromRecord(data as PropertyRow);
}

export async function loadStayMessageSettings(db: SupabaseClient, scope: { workspaceId: string | null }): Promise<StayMessageSettings> {
  if (!scope.workspaceId) return normalizeStayMessageSettings(null);
  try {
    const { data, error } = await db.from("workspace_automation_settings").select("row_data").eq("workspace_id", scope.workspaceId).maybeSingle();
    if (error) return normalizeStayMessageSettings(null);
    return normalizeStayMessageSettings(asRecord((data as { row_data?: unknown } | null)?.row_data).stayMessages);
  } catch {
    return normalizeStayMessageSettings(null);
  }
}

async function profilesById(db: SupabaseClient, ids: string[]): Promise<Map<string, { email: string; phone: string }>> {
  const out = new Map<string, { email: string; phone: string }>();
  if (ids.length === 0) return out;
  const { data } = await db.from("profiles").select("id, email, phone").in("id", ids);
  for (const raw of (data ?? []) as Array<{ id?: unknown; email?: unknown; phone?: unknown }>) {
    out.set(text(raw.id), { email: text(raw.email).toLowerCase(), phone: normalizeE164(text(raw.phone)) ?? "" });
  }
  return out;
}

/** Room-date blocks (short stays and channel stays) in the send window, cancelled ones included so the ledger can mark them. */
async function blockCandidates(db: SupabaseClient, now: Date, properties: Map<string, PropertyRow>): Promise<StayCandidate[]> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data, created_at")
    .in("record_type", [ROOM_DATE_BLOCK_RECORD_TYPE, CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE])
    .gte("ends_at", new Date(now.getTime() - 2 * DAY_MS).toISOString())
    .lte("starts_at", new Date(now.getTime() + 3 * DAY_MS).toISOString())
    .limit(MAX_ROWS);
  if (error) throw error;
  const records = (data ?? []) as Array<Record<string, unknown>>;
  const missing = [...new Set(records.map((r) => text(r.property_id) || text(asRecord(r.row_data).propertyId)).filter((id) => id && !properties.has(id)))];
  if (missing.length > 0) {
    const { data: props } = await db.from("manager_property_records").select("id, workspace_id, manager_user_id, row_data, property_data").in("id", missing);
    for (const p of (props ?? []) as PropertyRow[]) properties.set(text(p.id), p);
  }
  const userIds = [...new Set(records.map((r) => text(asRecord(r.row_data).residentUserId)).filter(Boolean))];
  const profiles = await profilesById(db, userIds);
  const out: StayCandidate[] = [];
  for (const record of records) {
    const rowData = asRecord(record.row_data);
    if (hasSmsTestProvenance(rowData)) continue;
    const propertyId = text(record.property_id) || text(rowData.propertyId);
    const property = properties.get(propertyId);
    const workspaceId = text(property?.workspace_id) || null;
    if (!property || !workspaceId) continue;
    // A nameless "CLOSED - Not available" block is a room closed, never a guest.
    if (rowData.blockKind === "closed" || !text(rowData.residentName)) continue;
    const checkIn = text(rowData.checkIn);
    const checkOut = text(rowData.checkOut);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) continue;
    const clock = propertyStayClockFromRecord({ row_data: property.row_data, property_data: property.property_data });
    const details = asRecord(rowData.stayDetails);
    const times = resolveStayTimes(
      { checkInTime: text(rowData.checkInTime), checkOutTime: text(rowData.checkOutTime), legacyEarlyCheckIn: text(details.earlyCheckIn), legacyLateCheckOut: text(details.lateCheckOut) },
      clock.times,
    );
    const addOns = asRecord(details.addOns) as StayAddOns;
    const paidEarly = addOns.early_check_in?.status === "paid" ? normalizeStayTime(addOns.early_check_in.time) : null;
    const paidLate = addOns.late_check_out?.status === "paid" ? normalizeStayTime(addOns.late_check_out.time) : null;
    const userId = text(rowData.residentUserId) || null;
    const profile = userId ? profiles.get(userId) : undefined;
    const cancelled = record.record_type === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE || text(rowData.bookingStatus) === "cancelled";
    const status = cancelled ? "cancelled" : text(rowData.bookingStatus) === "confirmed" ? "confirmed" : "hold";
    out.push({
      stayKey: `block:${text(record.id)}`,
      stayKind: "block",
      workspaceId,
      ownerUserId: text(record.manager_user_id) || text(property.manager_user_id),
      propertyId,
      roomId: text(rowData.roomId),
      source: staySourceOf({ stayDetailsSource: details.source, channelProvider: asRecord(details.channelLink).provider }),
      status,
      guestName: text(rowData.residentName),
      guestEmail: text(rowData.residentEmail).toLowerCase() || profile?.email || null,
      guestPhone: normalizeE164(text(rowData.residentPhone)) ?? (profile?.phone || null),
      guestUserId: userId,
      checkIn,
      checkOut: rowData.openEnded === true || checkOut === "9999-12-31" ? null : /^\d{4}-\d{2}-\d{2}$/.test(checkOut) ? checkOut : null,
      checkInTime: paidEarly && stayTimeMinutes(paidEarly) < stayTimeMinutes(times.checkInTime) ? paidEarly : times.checkInTime,
      checkOutTime: paidLate && stayTimeMinutes(paidLate) > stayTimeMinutes(times.checkOutTime) ? paidLate : times.checkOutTime,
      createdAt: text(rowData.createdAt) || text(record.created_at) || null,
      leaseSigned: true,
    });
  }
  return out;
}

/** Long-term residents moving in inside the window: only with a signed lease (the reveal rule), keyed `lease:<application id>`. */
async function leaseCandidates(db: SupabaseClient, now: Date, properties: Map<string, PropertyRow>): Promise<StayCandidate[]> {
  const tenancies = (await loadTenancies(db)).filter(
    (row): row is typeof row & { moveIn: Date; propertyId: string } =>
      Boolean(row.moveIn && row.propertyId) && row.moveIn!.getTime() > now.getTime() - 2 * DAY_MS && row.moveIn!.getTime() < now.getTime() + 4 * DAY_MS,
  );
  if (tenancies.length === 0) return [];
  const ids = tenancies.map((row) => row.id);
  const { data } = await db.from("manager_application_records").select("id, row_data").in("id", ids);
  const rowsById = new Map((data ?? []).map((r) => [text((r as { id?: unknown }).id), asRecord((r as { row_data?: unknown }).row_data)]));
  const missing = [...new Set(tenancies.map((row) => row.propertyId).filter((id) => !properties.has(id)))];
  if (missing.length > 0) {
    const { data: props } = await db.from("manager_property_records").select("id, workspace_id, manager_user_id, row_data, property_data").in("id", missing);
    for (const p of (props ?? []) as PropertyRow[]) properties.set(text(p.id), p);
  }
  const out: StayCandidate[] = [];
  for (const row of tenancies) {
    const property = properties.get(row.propertyId);
    const workspaceId = text(property?.workspace_id) || null;
    if (!property || !workspaceId) continue;
    const rowData = rowsById.get(row.id) ?? {};
    if (hasSmsTestProvenance(rowData)) continue;
    let signed = false;
    try {
      signed = (await loadResidentLeaseSignedStatus(row.residentEmail, row.managerUserId)) || (await loadResidentManagerAttestedTenancy(row.residentEmail, row.managerUserId));
    } catch {
      signed = false;
    }
    const choice = text(rowData.assignedRoomChoice) || text(asRecord(rowData.application).roomChoice1);
    const roomId = choice.includes("::") ? choice.slice(choice.indexOf("::") + 2).trim() : "";
    const clock = propertyStayClockFromRecord({ row_data: property.row_data, property_data: property.property_data });
    out.push({
      stayKey: `lease:${row.id}`,
      stayKind: "lease",
      workspaceId,
      ownerUserId: row.managerUserId,
      propertyId: row.propertyId,
      roomId,
      source: "resident",
      status: "confirmed",
      guestName: row.residentName,
      guestEmail: row.residentEmail || null,
      guestPhone: normalizeE164(text(rowData.phone) || text(asRecord(rowData.application).phone)),
      guestUserId: row.residentUserId,
      checkIn: formatIsoDateInput(row.moveIn),
      checkOut: null,
      checkInTime: clock.times.checkInTime,
      checkOutTime: clock.times.checkOutTime,
      createdAt: text(rowData.createdAt) || null,
      leaseSigned: signed,
    });
  }
  return out;
}

export async function loadStayCandidates(db: SupabaseClient, now: Date): Promise<StayCandidate[]> {
  const properties = new Map<string, PropertyRow>();
  const blocks = await blockCandidates(db, now, properties);
  let leases: StayCandidate[] = [];
  try {
    leases = await leaseCandidates(db, now, properties);
  } catch (cause) {
    // Short stays still go out when the tenancy read is down.
    console.error("stay messages: tenancy read failed", cause instanceof Error ? cause.message : "unknown");
  }
  return [...blocks, ...leases];
}

export type { HouseInfoV1 };
export { houseInfoWithoutInternal };
