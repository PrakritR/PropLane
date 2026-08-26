import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { notifyTenantTourRequestRemoved } from "@/lib/tour-notification-delivery.server";

export const runtime = "nodejs";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function inquiryRowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const row = asObject(rowData);
  const payload = row?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

function windowsFromInquiry(row: Record<string, unknown>): { start: string; end: string; managerUserId: string }[] {
  const windows = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const fromWindows = windows
    .map(asObject)
    .filter((window): window is Record<string, unknown> => Boolean(window))
    .map((window) => ({
      start: textField(window, "start"),
      end: textField(window, "end"),
      managerUserId: textField(row, "managerUserId") || textField(window, "adminUserId"),
    }))
    .filter((window) => window.start && window.end && window.managerUserId);
  if (fromWindows.length > 0) return fromWindows;

  const start = textField(row, "proposedStart");
  const end = textField(row, "proposedEnd");
  const managerUserId = textField(row, "managerUserId") || textField(row, "adminUserId");
  return start && end && managerUserId ? [{ start, end, managerUserId }] : [];
}

function sameTourSlot(row: Record<string, unknown>, managerUserId: string, start: string, end: string): boolean {
  if (textField(row, "kind") !== "tour") return false;
  return windowsFromInquiry(row).some(
    (window) => window.managerUserId === managerUserId && sameInstant(window.start, start) && sameInstant(window.end, end),
  );
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

function inquiryManagerUserId(row: Record<string, unknown>): string {
  return textField(row, "managerUserId") || textField(row, "adminUserId");
}

/** A manager may only mutate inquiries they own — the singleton payload is global. */
function inquiryOwnedByManager(row: Record<string, unknown>, managerUserId: string): boolean {
  const owner = inquiryManagerUserId(row);
  return Boolean(owner && owner === managerUserId);
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as {
      id?: unknown;
      managerUserId?: unknown;
      start?: unknown;
      end?: unknown;
      notifyTenant?: unknown;
      subject?: unknown;
      messageBody?: unknown;
      body?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const start = typeof body.start === "string" ? body.start.trim() : "";
    const end = typeof body.end === "string" ? body.end.trim() : "";
    const requestedManagerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    const notifyTenant = body.notifyTenant !== false;
    const customSubject = typeof body.subject === "string" ? body.subject.trim() : "";
    const customBody =
      typeof body.messageBody === "string"
        ? body.messageBody.trim()
        : typeof body.body === "string"
          ? body.body.trim()
          : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const admin = await isAdminUser(user.id);
    const managerUserId = admin ? requestedManagerUserId : user.id;
    if (!managerUserId) return NextResponse.json({ error: "managerUserId required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const eventQuery = db
      .from("portal_schedule_records")
      .select("id, manager_user_id, starts_at, ends_at, row_data")
      .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
      .eq("manager_user_id", managerUserId);

    const { data: eventRows, error: eventError } = await eventQuery;
    if (eventError) return NextResponse.json({ error: eventError.message }, { status: 500 });

    const matchingEventRows = ((eventRows ?? []) as {
      id?: string | null;
      manager_user_id?: string | null;
      starts_at?: string | null;
      ends_at?: string | null;
      row_data?: unknown;
    }[]).filter((eventRow) => {
      const payload = asObject(asObject(eventRow.row_data)?.payload);
      const payloadId = textField(payload, "id");
      return (
        eventRow.id === `${INQUIRY_EVENT_RECORD_TYPE}_${id}_0` ||
        payloadId === id ||
        Boolean(start && end && sameInstant(eventRow.starts_at, start) && sameInstant(eventRow.ends_at, end))
      );
    });

    const idsToRemove = new Set<string>([id]);
    const eventIdsToDelete = new Set<string>();
    for (const eventRow of matchingEventRows) {
      if (eventRow.id) eventIdsToDelete.add(eventRow.id);
      const payload = asObject(asObject(eventRow.row_data)?.payload);
      const payloadId = textField(payload, "id");
      if (payloadId) idsToRemove.add(payloadId);
    }
    eventIdsToDelete.add(`${INQUIRY_EVENT_RECORD_TYPE}_${id}_0`);

    const { data: inquiryRecord, error: inquiryError } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", INQUIRIES_RECORD_ID)
      .maybeSingle();
    if (inquiryError) return NextResponse.json({ error: inquiryError.message }, { status: 500 });

    const currentInquiries = inquiryRowsFromRecord(inquiryRecord?.row_data);
    const targetInquiry = currentInquiries.find((row) => textField(row, "id") === id);
    if (targetInquiry && !inquiryOwnedByManager(targetInquiry, managerUserId)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    let guestNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;
    if (targetInquiry && textField(targetInquiry, "kind") === "tour" && notifyTenant) {
      const window = windowsFromInquiry(targetInquiry)[0];
      guestNotification = await notifyTenantTourRequestRemoved(db, req, targetInquiry, window, {
        subject: customSubject || undefined,
        body: customBody || undefined,
      });
      if (!guestNotification.ok && !guestNotification.skipped) {
        return NextResponse.json(
          { error: guestNotification.error ?? "Could not notify the guest before deleting this tour request." },
          { status: 500 },
        );
      }
    }

    const nextInquiries = currentInquiries.map((row) => {
      const rowId = textField(row, "id");
      const owned = inquiryOwnedByManager(row, managerUserId);
      if (!owned) return row;
      if (idsToRemove.has(rowId)) {
        return { ...row, status: "declined" };
      }
      if (start && end && sameTourSlot(row, managerUserId, start, end)) {
        return { ...row, status: "declined" };
      }
      return row;
    });

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
          payload: nextInquiries,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (writeError) return NextResponse.json({ error: writeError.message }, { status: 500 });

    const eventIds = [...eventIdsToDelete];
    if (eventIds.length > 0) {
      const { error: deleteError } = await db.from("portal_schedule_records").delete().in("id", eventIds);
      if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      removedIds: [...idsToRemove],
      removedEventIds: eventIds,
      guestNotification,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete tour inquiry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
