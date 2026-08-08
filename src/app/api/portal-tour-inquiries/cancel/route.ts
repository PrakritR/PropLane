import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { cancelPlannedTour } from "@/lib/tour-planned-change.server";

export const runtime = "nodejs";

/** Cancel a CONFIRMED tour and notify the guest PropLane already committed to. */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as {
      id?: unknown;
      reason?: unknown;
      notifyGuest?: unknown;
      subject?: unknown;
      messageBody?: unknown;
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
    const result = await cancelPlannedTour(db, {
      plannedEventId: id,
      actorUserId: user.id,
      isAdmin: await isAdminUser(user.id),
      reason: typeof body.reason === "string" ? body.reason.trim() : null,
      // Notifying is the default; only an explicit `false` opts out.
      notifyGuest: body.notifyGuest !== false,
      notificationSubject: typeof body.subject === "string" ? body.subject.trim() : undefined,
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
    const message = e instanceof Error ? e.message : "Failed to cancel tour.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
