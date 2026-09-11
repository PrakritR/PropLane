import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelPlannedTour } from "@/lib/tour-planned-change.server";
import { recordResidentProspectInboxMessage } from "@/lib/tour-notification-delivery.server";
import { resolveResidentTourLinks, type ResidentTourLinkRow } from "@/lib/tour-resident-link.server";

type Db = SupabaseClient;

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function rowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

export type ResidentTourCancelResult =
  | { ok: true; outcome: "request-withdrawn" | "tour-cancelled" }
  | { ok: false; status: 400 | 403 | 404 | 500; error: string };

/**
 * A resident withdraws their own tour — the one action the resident tour
 * popup offers besides rescheduling and messaging the host.
 *
 * Authorization is the resident's own link to the inquiry (`resident_tour_links`,
 * or the inquiry's email when links are still being back-filled); nothing on
 * the manager's calendar is touched for an inquiry the resident does not hold.
 * A pending request is marked `cancelled` on the inquiry record and its
 * request-slot rows are removed so the slot frees; a confirmed tour goes
 * through the same `cancelPlannedTour` write the manager uses, acting as that
 * tour's own manager (the resident is the guest, so no guest notice is sent).
 * The manager hears about it in the property thread either way.
 */
export async function cancelResidentTour(
  db: Db,
  input: { userId: string; email: string | null; inquiryId: string; reason?: string | null },
): Promise<ResidentTourCancelResult> {
  const inquiryId = input.inquiryId.trim();
  if (!inquiryId) return { ok: false, status: 400, error: "Tour id required." };

  const links = await resolveResidentTourLinks(db, { userId: input.userId, email: input.email });
  const link: ResidentTourLinkRow | undefined = links.find((row) => row.inquiry_id === inquiryId);
  if (!link) return { ok: false, status: 403, error: "That tour is not on your account." };

  const { data: inquiryRecord, error: inquiryError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (inquiryError) return { ok: false, status: 500, error: inquiryError.message };
  const inquiries = rowsFromRecord(inquiryRecord?.row_data);
  const inquiry = inquiries.find((row) => textField(row, "id") === inquiryId) ?? null;

  const { data: plannedRecord, error: plannedError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedError) return { ok: false, status: 500, error: plannedError.message };
  const planned = rowsFromRecord(plannedRecord?.row_data).find(
    (event) =>
      textField(event, "kind") === "tour" &&
      !textField(event, "canceledAt") &&
      (textField(event, "sourceInquiryId") === inquiryId ||
        (Boolean(link.tour_group_id) && textField(event, "tourGroupId") === link.tour_group_id)),
  );

  const managerUserId =
    (inquiry ? textField(inquiry, "managerUserId") || textField(inquiry, "adminUserId") : "") ||
    (planned ? textField(planned, "managerUserId") : "") ||
    link.manager_user_id ||
    "";
  const propertyId = (inquiry ? textField(inquiry, "propertyId") : "") || (planned ? textField(planned, "propertyId") : "") || link.property_id || "";
  const propertyTitle = (inquiry ? textField(inquiry, "propertyTitle") : "") || (planned ? textField(planned, "propertyTitle") : "");
  const guestName = (inquiry ? textField(inquiry, "name") : "") || (planned ? textField(planned, "attendeeName") : "") || "A resident";
  const reason = input.reason?.trim() || "";

  let outcome: "request-withdrawn" | "tour-cancelled" = "request-withdrawn";

  if (planned) {
    const plannedEventId = textField(planned, "id");
    const eventManagerId = textField(planned, "managerUserId");
    if (!plannedEventId || !eventManagerId) return { ok: false, status: 500, error: "Tour record is incomplete." };
    const cancelled = await cancelPlannedTour(db, {
      plannedEventId,
      actorUserId: eventManagerId,
      reason: reason || "Cancelled by the guest.",
      notifyGuest: false,
    });
    if (!cancelled.ok) return { ok: false, status: cancelled.status === 404 ? 404 : 500, error: cancelled.error };
    outcome = "tour-cancelled";
  }

  if (inquiry) {
    const nowIso = new Date().toISOString();
    const next = inquiries.map((row) =>
      textField(row, "id") === inquiryId
        ? { ...row, status: "cancelled", cancelledAt: nowIso, cancelledBy: "resident", ...(reason ? { cancelReason: reason } : {}) }
        : row,
    );
    const { error: writeError } = await db.from("portal_schedule_records").upsert(
      {
        id: INQUIRIES_RECORD_ID,
        manager_user_id: null,
        property_id: null,
        record_type: INQUIRIES_RECORD_ID,
        row_data: {
          id: INQUIRIES_RECORD_ID,
          recordType: INQUIRIES_RECORD_ID,
          managerUserId: null,
          propertyId: null,
          payload: next,
        },
        updated_at: nowIso,
      },
      { onConflict: "id" },
    );
    if (writeError) return { ok: false, status: 500, error: writeError.message };

    // The request's held slot rows, so the window opens up again for others.
    const { data: eventRows } = await db
      .from("portal_schedule_records")
      .select("id, row_data")
      .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
      .eq("manager_user_id", managerUserId || "__none__");
    const eventIds = new Set<string>([`${INQUIRY_EVENT_RECORD_TYPE}_${inquiryId}_0`]);
    for (const eventRow of (eventRows ?? []) as { id?: string | null; row_data?: unknown }[]) {
      const payload = asObject(asObject(eventRow.row_data)?.payload);
      if (eventRow.id && textField(payload, "id") === inquiryId) eventIds.add(eventRow.id);
    }
    await db.from("portal_schedule_records").delete().in("id", [...eventIds]);
  } else if (!planned) {
    return { ok: false, status: 404, error: "That tour is no longer on file." };
  }

  const email = input.email?.trim().toLowerCase() ?? "";
  if (email.includes("@") && managerUserId) {
    try {
      await recordResidentProspectInboxMessage(db, {
        participantEmail: email,
        subject: outcome === "tour-cancelled" ? "Tour cancelled by the guest" : "Tour request withdrawn",
        body:
          `${guestName} ${outcome === "tour-cancelled" ? "cancelled their tour" : "withdrew their tour request"}` +
          `${propertyTitle ? ` for ${propertyTitle}` : ""}.${reason ? ` Reason: ${reason}` : ""}`,
        residentName: guestName,
        managerUserId,
        propertyId: propertyId || undefined,
        propertyTitle: propertyTitle || undefined,
      });
    } catch {
      // The cancellation already landed; a failed inbox note must not undo it.
    }
  }

  return { ok: true, outcome };
}
