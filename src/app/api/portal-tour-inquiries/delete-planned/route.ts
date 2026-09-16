import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deletePlannedTour } from "@/lib/tour-planned-change.server";

export const runtime = "nodejs";

/**
 * Remove a planned tour outright (past, cancelled or upcoming). Unlike
 * `cancel`, which keeps the row as history, this drops it — and, only when the
 * manager asked, tells the guest the same way a cancel would.
 */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as {
      id?: unknown;
      notifyGuest?: unknown;
      subject?: unknown;
      messageBody?: unknown;
      deliverViaEmail?: unknown;
      deliverViaSms?: unknown;
      body?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const customBody =
      typeof body.messageBody === "string"
        ? body.messageBody.trim()
        : typeof body.body === "string"
          ? body.body.trim()
          : "";

    const db = createSupabaseServiceRoleClient();
    const result = await deletePlannedTour(db, {
      plannedEventId: id,
      actorUserId: user.id,
      isAdmin: await isAdminUser(user.id),
      // Delete is silent unless the manager explicitly chose to message: a
      // past tour has nothing to announce, and the sheet passes true itself.
      notifyGuest: body.notifyGuest === true,
      notificationSubject: typeof body.subject === "string" ? body.subject.trim() : undefined,
      notificationBody: customBody || undefined,
      notificationChannels: {
        ...(typeof body.deliverViaEmail === "boolean" ? { viaEmail: body.deliverViaEmail } : {}),
        ...(typeof body.deliverViaSms === "boolean" ? { viaSms: body.deliverViaSms } : {}),
      },
      req,
    });

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      ok: true,
      message: result.message,
      guestNotification: result.guestNotification,
      calendarSync: result.calendarSync,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete tour.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
