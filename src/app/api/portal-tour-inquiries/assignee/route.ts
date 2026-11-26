import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getTourAssigneeInfo, listTourAssigneeCandidatesForProperty, reassignPlannedTour } from "@/lib/tour-assignee.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

async function actor() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  if ((await resolveAuthenticatedBusinessAccess(user.id)).kind === "denied") {
    return { error: NextResponse.json({ error: "Tour access is unavailable for this account." }, { status: 403 }) } as const;
  }
  return { userId: user.id, isAdmin: await isAdminUser(user.id) } as const;
}

/**
 * Who a confirmed tour is assigned to, who it may be reassigned to, and the calendar note (`?id=<plannedEventId>`), or
 * who a tour NOT yet created at a house may be assigned to (`?propertyId=<id>`), which is the one list the confirm and
 * manual-booking pickers offer.
 */
export async function GET(req: Request) {
  try {
    const who = await actor();
    if ("error" in who) return who.error;
    const params = new URL(req.url).searchParams;
    const propertyId = params.get("propertyId")?.trim() ?? "";
    if (propertyId) {
      const team = await listTourAssigneeCandidatesForProperty(createSupabaseServiceRoleClient(), { propertyId, actorUserId: who.userId, isAdmin: who.isAdmin });
      if (!team.ok) return NextResponse.json({ error: team.error }, { status: team.status });
      return NextResponse.json({ defaultUserId: team.defaultUserId, candidates: team.candidates });
    }
    const id = params.get("id")?.trim() ?? "";
    const result = await getTourAssigneeInfo(createSupabaseServiceRoleClient(), { plannedEventId: id, actorUserId: who.userId, isAdmin: who.isAdmin });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const { ok: _ok, ...info } = result;
    return NextResponse.json(info);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load the tour assignee." }, { status: 500 });
  }
}

/** Reassign a confirmed tour; the Google event moves to the new assignee's calendar. */
export async function POST(req: Request) {
  try {
    const who = await actor();
    if ("error" in who) return who.error;
    const body = (await req.json()) as { id?: unknown; assigneeUserId?: unknown };
    const result = await reassignPlannedTour(createSupabaseServiceRoleClient(), {
      plannedEventId: typeof body.id === "string" ? body.id : "",
      assigneeUserId: typeof body.assigneeUserId === "string" ? body.assigneeUserId : "",
      actorUserId: who.userId,
      isAdmin: who.isAdmin,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, assignee: result.assignee, calendarSync: result.calendarSync });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to reassign the tour." }, { status: 500 });
  }
}
