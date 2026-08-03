import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { deliverResidentWorkOrderReminder } from "@/lib/resident-work-order-reminder.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

async function sessionActor(db: Db) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  const admin = await isAdminUser(user.id);
  const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
  const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const resident = await authorizeResidentRole(db, { userId: user.id, legacyRole });
  return {
    userId: user.id,
    email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    fullName: profile?.full_name?.trim() || "",
    admin,
    resident,
  };
}

/** Resident follow-up on a pending maintenance work order — inbox + email to property managers. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!actor.admin && !actor.resident) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as { workOrderId?: string };
    const workOrderId = String(body.workOrderId ?? "").trim();
    if (!workOrderId) return NextResponse.json({ error: "Work order id required." }, { status: 400 });

    const result = await deliverResidentWorkOrderReminder(db, {
      workOrderId,
      residentUserId: actor.userId,
      residentEmail: actor.email,
      residentName: actor.fullName,
    });
    if (!result.ok) {
      const status =
        result.error === "Forbidden."
          ? 403
          : result.error === "Work order not found."
            ? 404
            : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    track("resident_work_order_reminder_sent", actor.userId, {
      work_order_id: workOrderId,
      recipient_count: result.recipientCount,
    });
    return NextResponse.json({ ok: true, recipientCount: result.recipientCount });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not send reminder.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
