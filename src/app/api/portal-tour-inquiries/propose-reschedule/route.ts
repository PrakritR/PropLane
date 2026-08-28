import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { notifyTenantTourRescheduled } from "@/lib/tour-notification-delivery.server";

export const runtime = "nodejs";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

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

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

function inquiryManagerUserId(row: Record<string, unknown>): string {
  return textField(row, "managerUserId") || textField(row, "adminUserId");
}

function inquiryOwnedByManager(row: Record<string, unknown>, managerUserId: string): boolean {
  const owner = inquiryManagerUserId(row);
  return Boolean(owner && owner === managerUserId);
}

type InquiryWindow = {
  start: string;
  end: string;
  adminUserId?: string;
  adminLabel?: string;
  slotKey?: string;
};

function windowsFromInquiry(row: Record<string, unknown>): InquiryWindow[] {
  const windows = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const fromWindows = windows
    .map(asObject)
    .filter((window): window is Record<string, unknown> => Boolean(window))
    .map((window) => ({
      start: textField(window, "start"),
      end: textField(window, "end"),
      adminUserId: textField(row, "managerUserId") || textField(window, "adminUserId"),
      adminLabel: textField(window, "adminLabel"),
      slotKey: textField(window, "slotKey") || undefined,
    }))
    .filter((window) => window.start && window.end);
  if (fromWindows.length > 0) return fromWindows;

  const start = textField(row, "proposedStart");
  const end = textField(row, "proposedEnd");
  const adminUserId = textField(row, "managerUserId") || textField(row, "adminUserId");
  return start && end ? [{ start, end, adminUserId }] : [];
}

/** Propose a new time on a pending tour request and ask the guest to confirm. */
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
      previousStart?: unknown;
      previousEnd?: unknown;
      start?: unknown;
      end?: unknown;
      notifyGuest?: unknown;
      subject?: unknown;
      messageBody?: unknown;
      body?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const previousStart = typeof body.previousStart === "string" ? body.previousStart.trim() : "";
    const previousEnd = typeof body.previousEnd === "string" ? body.previousEnd.trim() : "";
    const start = typeof body.start === "string" ? body.start.trim() : "";
    const end = typeof body.end === "string" ? body.end.trim() : "";
    const requestedManagerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    const notifyGuest = body.notifyGuest !== false;
    const customSubject = typeof body.subject === "string" ? body.subject.trim() : "";
    const customBody =
      typeof body.messageBody === "string"
        ? body.messageBody.trim()
        : typeof body.body === "string"
          ? body.body.trim()
          : "";
    if (!id || !previousStart || !previousEnd || !start || !end) {
      return NextResponse.json({ error: "id, previousStart, previousEnd, start, and end are required." }, { status: 400 });
    }

    const admin = await isAdminUser(user.id);
    const managerUserId = admin ? requestedManagerUserId : user.id;
    if (!managerUserId) return NextResponse.json({ error: "managerUserId required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data: inquiryRecord, error: inquiryError } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", INQUIRIES_RECORD_ID)
      .maybeSingle();
    if (inquiryError) return NextResponse.json({ error: inquiryError.message }, { status: 500 });

    const currentInquiries = inquiryRowsFromRecord(inquiryRecord?.row_data);
    const targetIndex = currentInquiries.findIndex((row) => textField(row, "id") === id);
    if (targetIndex === -1) return NextResponse.json({ error: "Tour request not found." }, { status: 404 });

    const targetInquiry = currentInquiries[targetIndex]!;
    if (!inquiryOwnedByManager(targetInquiry, managerUserId)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    if (textField(targetInquiry, "kind") !== "tour" || textField(targetInquiry, "status") !== "pending") {
      return NextResponse.json({ error: "Only pending tour requests can be proposed for reschedule." }, { status: 400 });
    }

    const windows = windowsFromInquiry(targetInquiry);
    const windowIndex = windows.findIndex(
      (window) => sameInstant(window.start, previousStart) && sameInstant(window.end, previousEnd),
    );
    if (windowIndex === -1) {
      return NextResponse.json({ error: "The original tour window no longer matches." }, { status: 409 });
    }

    const nextWindows = windows.map((window, index) =>
      index === windowIndex ? { ...window, start, end } : window,
    );
    const updatedInquiry = {
      ...targetInquiry,
      requestedWindows: nextWindows,
      proposedStart: nextWindows[0]?.start ?? start,
      proposedEnd: nextWindows[0]?.end ?? end,
    };
    const nextInquiries = [...currentInquiries];
    nextInquiries[targetIndex] = updatedInquiry;

    let guestNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;

    const previousRowData = inquiryRecord?.row_data;

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

    if (notifyGuest) {
      guestNotification = await notifyTenantTourRescheduled(db, req, updatedInquiry, {
        window: {
          start,
          end,
          managerUserId,
          adminLabel: nextWindows[windowIndex]?.adminLabel,
        },
        previousWindow: { start: previousStart, end: previousEnd },
        subject: customSubject || undefined,
        body: customBody || undefined,
      });
      if (!guestNotification.ok && !guestNotification.skipped) {
        if (previousRowData) {
          await db.from("portal_schedule_records").upsert(
            {
              id: INQUIRIES_RECORD_ID,
              manager_user_id: null,
              property_id: null,
              record_type: INQUIRIES_RECORD_ID,
              row_data: previousRowData,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "id" },
          );
        }
        return NextResponse.json(
          { error: guestNotification.error ?? "Could not notify the guest about the new time." },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ ok: true, guestNotification });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to propose tour reschedule.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
