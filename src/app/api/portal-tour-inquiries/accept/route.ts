import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { confirmTourInquiry } from "@/lib/tour-inquiry-confirm.server";
import { normalizeAssignee } from "@/lib/work-assignment";

export const runtime = "nodejs";

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
      instructions?: unknown;
      notifyTenant?: unknown;
      subject?: unknown;
      messageBody?: unknown;
      body?: unknown;
      assignee?: unknown;
      hostUserId?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const admin = await isAdminUser(user.id);
    const db = createSupabaseServiceRoleClient();

    const customBody =
      typeof body.messageBody === "string"
        ? body.messageBody.trim()
        : typeof body.body === "string"
          ? body.body.trim()
          : "";

    const result = await confirmTourInquiry(db, {
      inquiryId: id,
      actorUserId: user.id,
      isAdmin: admin,
      requestedStart: typeof body.start === "string" ? body.start.trim() : "",
      requestedEnd: typeof body.end === "string" ? body.end.trim() : "",
      instructions: typeof body.instructions === "string" ? body.instructions.trim() : "",
      notifyTenant: body.notifyTenant === true,
      notificationSubject: typeof body.subject === "string" ? body.subject.trim() : undefined,
      notificationBody: customBody || undefined,
      assignee: normalizeAssignee(body.assignee),
      // Absent, approving claims the tour for the caller. Naming a host hands it
      // over; the confirm path re-checks that they may host this property and
      // are free at that hour, and refuses rather than warning.
      hostUserId: typeof body.hostUserId === "string" ? body.hostUserId.trim() : undefined,
      req,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      ok: true,
      plannedEvent: result.plannedEvent,
      message: result.message,
      tenantNotification: result.tenantNotification,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to approve tour request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
