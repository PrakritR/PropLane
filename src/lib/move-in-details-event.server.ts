import "server-only";

/**
 * Sends the two move-in announcements a resident reads as cards in their one conversation (A3, stay chat):
 * `move_in_details` and `room_assigned` on the shared action-event bus (domain `lease`: the domain column is a
 * database check list, so the two events join the lease catalog rather than needing a migration).
 *
 * `move_in_details` is the ONE card for the welcome. The `resident_welcome` reminder
 * (`reminders/dispatch.server.ts`) and a manager's own send both come through `emitMoveInDetails` with the same
 * event key (resident + home), so whichever runs first sends and every later one is a duplicate the bus drops.
 * Turning the welcome sequence on can never double-send it.
 *
 * Read `move-in-details-event.ts` before touching the text: no entry code, lockbox, gate code or Wi-Fi password
 * is ever written into it, only "entry code in the lease packet" and a link to the resident's own Move-in page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { emitActionEvent } from "@/lib/action-events.server";
import { managerSender } from "@/lib/domain-action-events.server";
import { residentNoticeChannel } from "@/lib/resident-notice-channel.server";
import { propertyStayClockFromRecord } from "@/lib/bookings/property-stay-times.server";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  asObject,
  propertyFromRecord,
  resolveBestResidentRow,
  resolveResidentMoveInFromApplications,
  type ResidentMoveInResolved,
} from "@/lib/resident-move-in-resolve";
import { propertyIdFromAppRow } from "@/lib/resident-move-in-info";
import {
  moveInDetailsEventKey,
  renderMoveInDetails,
  renderRoomAssigned,
  roomAssignedEventKey,
  roomAssignmentTransition,
} from "@/lib/move-in-details-event";

type Sender = { userId: string; email: string; name?: string };

type MoveInContext = {
  row: DemoApplicantRow;
  applicationId: string;
  propertyId: string;
  resolved: ResidentMoveInResolved;
  checkInTime: string;
  residentUserId: string | null;
  residentEmail: string;
  residentName: string;
};

/**
 * The resident's current home for one workspace, from their approved application and the listing's Move-in
 * card. Every read is scoped to the manager, so a resident of another workspace is never described. `null`
 * when there is no placed, approved residency to describe.
 */
async function loadMoveInContext(
  db: SupabaseClient,
  input: { managerUserId: string; residentEmail: string; row?: DemoApplicantRow | null; applicationId?: string },
): Promise<MoveInContext | null> {
  const email = input.residentEmail.trim().toLowerCase();
  if (!email) return null;
  let row = input.row ?? null;
  let applicationId = input.applicationId ?? "";
  if (!row) {
    const { data, error } = await db
      .from("manager_application_records")
      .select("id, row_data, updated_at")
      .eq("manager_user_id", input.managerUserId)
      .eq("resident_email", email)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Could not read the resident's application: ${error.message}`);
    const apps: Array<{ id: string; row: DemoApplicantRow }> = [];
    for (const record of data ?? []) {
      const rowData = asObject(record.row_data) as unknown as DemoApplicantRow | null;
      if (rowData) apps.push({ id: String(record.id), row: { ...rowData, email: rowData.email?.trim().toLowerCase() || email } });
    }
    const current = apps.filter((entry) => isCurrentResidentApplicationRow(entry.row) && !entry.row.withdrawnAt);
    const pool = (current.length ? current : apps).map((entry) => entry.row);
    row = resolveBestResidentRow(email, pool);
    applicationId = apps.find((entry) => entry.row === row)?.id ?? "";
  }
  if (!row) return null;
  const propertyId = propertyIdFromAppRow(row);
  if (!propertyId) return null;
  const { data: propertyRecord, error: propertyError } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", propertyId)
    .eq("manager_user_id", input.managerUserId)
    .maybeSingle();
  if (propertyError) throw new Error(`Could not read the home: ${propertyError.message}`);
  if (!propertyRecord) return null;
  const property = propertyFromRecord(propertyRecord as { id: string; property_data: unknown; row_data: unknown });
  const resolved = resolveResidentMoveInFromApplications(email, [row], { [propertyId]: property });
  if (!resolved) return null;
  const clock = propertyStayClockFromRecord(propertyRecord as { row_data?: unknown; property_data?: unknown });
  const residentUserId = String((row as { residentUserId?: unknown }).residentUserId ?? "").trim() || null;
  return {
    row,
    applicationId: applicationId || String(row.id ?? ""),
    propertyId,
    resolved,
    checkInTime: clock.times.checkInTime,
    residentUserId,
    residentEmail: email,
    residentName: String(row.name ?? "").trim(),
  };
}

export type EmitMoveInDetailsResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "no_home" | "no_address" | "no_sender" };

/**
 * Announce the resident's move-in details in their conversation. Idempotent per resident and home: a second
 * call (the welcome sequence's later timings, a manager pressing send after the welcome went) is a no-op.
 */
export async function emitMoveInDetails(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    residentEmail: string;
    residentUserId?: string | null;
    sender?: Sender;
  },
): Promise<EmitMoveInDetailsResult> {
  const context = await loadMoveInContext(db, { managerUserId: input.managerUserId, residentEmail: input.residentEmail });
  if (!context) return { ok: false, reason: "no_home" };
  const rendered = renderMoveInDetails({
    residentName: context.residentName,
    propertyLabel: context.resolved.propertyLabel,
    addressLine: context.resolved.addressLine,
    roomLabel: context.resolved.roomLabel,
    moveInDateLabel: context.resolved.earliestMoveInDateLabel,
    checkInTime: context.checkInTime,
    houseInfo: context.resolved.houseInfo,
  });
  if (!rendered) return { ok: false, reason: "no_address" };
  const sender = input.sender ?? (await managerSender(db, input.managerUserId));
  if (!sender.email) return { ok: false, reason: "no_sender" };
  const residentUserId = input.residentUserId?.trim() || context.residentUserId || undefined;
  const result = await emitActionEvent(db, {
    // Keyed on the application (the stay's record), never on who the caller could name: the welcome sequence passes the
    // resident's user id and a manager's own send does not, and both must be one card.
    eventId: moveInDetailsEventKey(context.applicationId || residentUserId || context.residentEmail, context.propertyId),
    domain: "lease",
    event: "move_in_details",
    managerUserId: input.managerUserId,
    entityId: context.applicationId,
    category: "leases",
    channel: await residentNoticeChannel(db, { managerUserId: input.managerUserId, email: context.residentEmail }),
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    // The card reads these stored facts; nothing secret is ever a payload field.
    payload: {
      propertyId: context.propertyId,
      propertyLabel: context.resolved.propertyLabel,
      cardFact: rendered.cardFact,
    },
    recipients: [
      {
        audience: "resident",
        userId: residentUserId,
        email: context.residentEmail,
        rendered: { subject: rendered.subject, text: rendered.text, smsText: rendered.smsText },
      },
    ],
  });
  return { ok: true, duplicate: result.duplicate };
}

/**
 * The resident's room was set or changed on an approved application. Fires after the write has committed
 * (the caller invokes it once the row is stored), idempotent on `room_assigned:<residency>:<room>`.
 */
export async function emitRoomAssignment(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    previous: DemoApplicantRow | null;
    application: DemoApplicantRow;
    actor?: Sender;
  },
): Promise<{ ok: true; duplicate: boolean } | { ok: false; reason: "no_change" | "no_room" | "no_recipient" | "no_sender" }> {
  const transition = roomAssignmentTransition(input.previous, input.application);
  if (!transition) return { ok: false, reason: "no_change" };
  const email = String(input.application.email ?? "").trim().toLowerCase();
  const residentUserId = String((input.application as { residentUserId?: unknown }).residentUserId ?? "").trim() || undefined;
  if (!email && !residentUserId) return { ok: false, reason: "no_recipient" };
  const context = await loadMoveInContext(db, {
    managerUserId: input.managerUserId,
    residentEmail: email,
    row: input.application,
    applicationId: String(input.application.id ?? ""),
  });
  const rendered = context
    ? renderRoomAssigned({
        residentName: context.residentName,
        propertyLabel: context.resolved.propertyLabel,
        roomLabel: context.resolved.roomLabel,
        changed: transition.changed,
        houseInfo: context.resolved.houseInfo,
      })
    : null;
  if (!context || !rendered) return { ok: false, reason: "no_room" };
  const sender = input.actor?.userId && input.actor.email ? input.actor : await managerSender(db, input.managerUserId);
  if (!sender.email) return { ok: false, reason: "no_sender" };
  const result = await emitActionEvent(db, {
    eventId: roomAssignedEventKey(context.applicationId, transition.choice),
    domain: "lease",
    event: "room_assigned",
    managerUserId: input.managerUserId,
    entityId: context.applicationId,
    category: "leases",
    channel: await residentNoticeChannel(db, { managerUserId: input.managerUserId, email: context.residentEmail }),
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    payload: {
      propertyId: context.propertyId,
      propertyLabel: context.resolved.propertyLabel,
      roomLabel: context.resolved.roomLabel,
      cardFact: rendered.cardFact,
    },
    recipients: [
      {
        audience: "resident",
        userId: residentUserId ?? context.residentUserId ?? undefined,
        email: context.residentEmail || undefined,
        rendered: { subject: rendered.subject, text: rendered.text, smsText: rendered.smsText },
      },
    ],
  });
  return { ok: true, duplicate: result.duplicate };
}
