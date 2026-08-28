import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reschedulePlannedTour } from "@/lib/tour-planned-change.server";

export const runtime = "nodejs";

/** Move a CONFIRMED tour to a new window and tell the guest the new time. */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as {
      id?: unknown;
      start?: unknown;
      end?: unknown;
      reason?: unknown;
      instructions?: unknown;
      notifyGuest?: unknown;
      subject?: unknown;
      body?: unknown;
      messageBody?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const customSubject = typeof body.subject === "string" ? body.subject.trim() : "";
    const customBody =
      typeof body.messageBody === "string"
        ? body.messageBody.trim()
        : typeof body.body === "string"
          ? body.body.trim()
          : "";
    const result = await reschedulePlannedTour(db, {
      plannedEventId: id,
      actorUserId: user.id,
      isAdmin: await isAdminUser(user.id),
      start: typeof body.start === "string" ? body.start : "",
      end: typeof body.end === "string" ? body.end : "",
      reason: typeof body.reason === "string" ? body.reason.trim() : null,
      instructions: typeof body.instructions === "string" ? body.instructions.trim() : null,
      notifyGuest: body.notifyGuest !== false,
      notificationSubject: customSubject || undefined,
      notificationBody: customBody || undefined,
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
    const message = e instanceof Error ? e.message : "Failed to reschedule tour.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
