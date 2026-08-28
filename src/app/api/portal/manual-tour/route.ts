import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { createManualPlannedTour } from "@/lib/manual-planned-tour.server";
import { normalizeAssignee } from "@/lib/work-assignment";

export const runtime = "nodejs";

const USER_FACING_ERRORS = new Set([
  "Property is required.",
  "Guest name is required.",
  "Start and end time are required.",
  "End time must be after start time.",
  "You do not have access to this property.",
  "Property not found.",
  "That time is already booked. Pick another slot.",
  "This assignee cannot take tours.",
]);

function routeError(e: unknown, fallback: string): string {
  if (e instanceof Error && USER_FACING_ERRORS.has(e.message)) return e.message;
  return fallback;
}

export async function POST(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const result = await createManualPlannedTour(
      ctx.db,
      ctx.userId,
      {
        propertyId: String(body?.propertyId ?? ""),
        propertyTitle: typeof body?.propertyTitle === "string" ? body.propertyTitle : undefined,
        roomLabel: typeof body?.roomLabel === "string" ? body.roomLabel : undefined,
        guestName: String(body?.guestName ?? ""),
        guestEmail: typeof body?.guestEmail === "string" ? body.guestEmail : undefined,
        guestPhone: typeof body?.guestPhone === "string" ? body.guestPhone : undefined,
        start: String(body?.start ?? ""),
        end: String(body?.end ?? ""),
        notes: typeof body?.notes === "string" ? body.notes : undefined,
        assignee: normalizeAssignee(body?.assignee),
      },
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      ok: true,
      plannedEvent: result.plannedEvent,
      message: result.message,
    });
  } catch (e) {
    return NextResponse.json({ error: routeError(e, "Could not schedule tour.") }, { status: 400 });
  }
}
